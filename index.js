/**
 * DCA Bot — Safety Order style (ala 3Commas) — Bitget Spot
 * Standalone project, terpisah dari bot UTBot.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('dotenv').config();

import readline from 'readline';
import { log }              from './logger.js';
import { config, saveConfig } from './config.js';
import { testConnection, getCurrentPrice } from './bitget.js';
import {
  getActiveSymbols, getDeal, getActiveDeals, getStats, getClosedDeals, hasActiveDeal,
  schedulePendingReopen, clearPendingReopen, getPendingReopens, untrackDeal,
} from './state.js';
import { evaluateDeal } from './dcaEngine.js';
import { openDeal, fillSafetyOrder, closeDealMarket } from './executor.js';
import {
  notifyDealOpened, notifySafetyOrder, notifyDealClosed, notifyDealUntracked, notifyError, notifyStartup,
} from './telegram.js';
import { startTelegramPolling, stopTelegramPolling } from './telegramCommands.js';
import { startApiServer } from './apiServer.js';
import { checkAllTrends } from './trendMonitor.js';

const isDryRun = process.env.DRY_RUN === 'true';
const args     = process.argv.slice(2);

let _loopBusy = false;
let _loopTimer = null;
let _trendTimer = null;

// ─────────────────────────────────────────────────────────────────────────────
// START / CLOSE DEAL (dipakai oleh Telegram & API)
// ─────────────────────────────────────────────────────────────────────────────
export async function startDeal(symbol) {
  if (hasActiveDeal(symbol)) return { ok: false, error: `Deal ${symbol} sudah aktif` };

  const active  = getActiveSymbols().length;
  const maxDeal = config.trading.maxActiveDeals ?? 5;
  if (active >= maxDeal) return { ok: false, error: `Slot deal penuh (${active}/${maxDeal})` };

  if (config.blacklist?.includes(symbol)) return { ok: false, error: `${symbol} ada di blacklist` };
  if (config.whitelist?.length && !config.whitelist.includes(symbol)) {
    return { ok: false, error: `${symbol} tidak ada di whitelist` };
  }

  try {
    const deal = await openDeal(symbol);
    await notifyDealOpened(deal);
    return { ok: true, deal };
  } catch (e) {
    log('executor_error', `Buka deal ${symbol} gagal: ${e.message}`);
    await notifyError(`Buka deal ${symbol} gagal: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO REOPEN — bisa di-toggle ON/OFF sewaktu-waktu lewat config.trading.reopenAfterClose
// ─────────────────────────────────────────────────────────────────────────────
function maybeScheduleReopen(closed) {
  const t = config.trading;
  if (!t.reopenAfterClose) return; // fitur OFF → tidak dijadwalkan sama sekali

  const reasons = t.reopenOnReasons ?? ['take_profit'];
  if (!reasons.includes(closed.reason)) return; // reason ini tidak termasuk yang di-reopen

  const cooldownMin = t.cooldownAfterCloseMin ?? 5;
  schedulePendingReopen(closed.symbol, Date.now(), cooldownMin);
  log('reopen', `⏳ ${closed.symbol} dijadwalkan auto-reopen dalam ${cooldownMin} menit (alasan close: ${closed.reason})`);
}

async function processPendingReopens() {
  const pending = getPendingReopens();
  const symbols = Object.keys(pending);
  if (symbols.length === 0) return;

  const now = Date.now();
  for (const symbol of symbols) {
    const info = pending[symbol];
    if (now < info.readyAt) continue; // cooldown belum selesai

    clearPendingReopen(symbol); // sekali coba, baik berhasil atau tidak — biar tidak spam retry

    if (!config.trading.reopenAfterClose) {
      log('reopen', `⏭️ Auto-reopen ${symbol} dilewati — fitur sedang OFF saat cooldown selesai`);
      continue;
    }
    if (hasActiveDeal(symbol)) continue; // sudah dibuka manual duluan

    log('reopen', `🔁 Cooldown selesai, membuka kembali ${symbol} otomatis...`);
    try {
      const res = await startDeal(symbol);
      if (!res.ok) log('reopen_warn', `Gagal auto-reopen ${symbol}: ${res.error}`);
    } catch (e) {
      log('reopen_warn', `Gagal auto-reopen ${symbol}: ${e.message}`);
    }
  }
}

/**
 * Close manual DENGAN eksekusi market sell asli dari bot.
 */
export async function closeDealManual(symbol) {
  if (!hasActiveDeal(symbol)) return { ok: false, error: `Deal ${symbol} tidak aktif` };
  try {
    const closed = await closeDealMarket(symbol, 'manual_close');
    await notifyDealClosed(closed);
    maybeScheduleReopen(closed);
    return { ok: true, closed };
  } catch (e) {
    log('executor_error', `Tutup deal ${symbol} gagal: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/**
 * Close manual TANPA eksekusi order — dipakai kalau user jual sendiri di luar bot
 * (langsung di app exchange). Bot cuma berhenti mantau deal ini. PnL TIDAK dihitung
 * ke statistik/Total PnL bot karena tidak ada harga jual asli yang bot tahu.
 */
export async function closeDealUntrack(symbol) {
  if (!hasActiveDeal(symbol)) return { ok: false, error: `Deal ${symbol} tidak aktif` };
  try {
    const closed = untrackDeal(symbol);
    await notifyDealUntracked(closed);
    maybeScheduleReopen(closed); // no-op kecuali user tambahin 'manual_untracked' ke reopenOnReasons
    return { ok: true, closed };
  } catch (e) {
    log('executor_error', `Untrack deal ${symbol} gagal: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN LOOP — cek tiap deal aktif, jalankan SO / TP / SL sesuai dcaEngine
// ─────────────────────────────────────────────────────────────────────────────
async function checkDeals() {
  if (_loopBusy) return;
  _loopBusy = true;
  try {
    const symbols = getActiveSymbols();

    for (const symbol of symbols) {
      const deal = getDeal(symbol);
      if (!deal) continue;

      try {
        const price = await getCurrentPrice(symbol);
        if (!price) continue;

        const decision = evaluateDeal(deal, price, config.dca);

        if (decision.action === 'take_profit') {
          log('dca', `🎯 TP hit: ${symbol} @ ${price} (TP=${deal.tpPrice.toFixed(6)})`);
          const closed = await closeDealMarket(symbol, 'take_profit');
          await notifyDealClosed(closed);
          maybeScheduleReopen(closed);

        } else if (decision.action === 'stop_loss') {
          log('dca', `🛑 SL hit: ${symbol} @ ${price} (SL=${deal.slPrice.toFixed(6)})`);
          const closed = await closeDealMarket(symbol, 'stop_loss');
          await notifyDealClosed(closed);
          maybeScheduleReopen(closed);

        } else if (decision.action === 'place_so') {
          log('dca', `➕ SO${decision.step} trigger: ${symbol} @ ${price} (target=${deal.nextSOPrice.toFixed(6)})`);
          const updated = await fillSafetyOrder(symbol, decision.step, decision.size);
          await notifySafetyOrder(updated, decision.step);

        } else {
          const slLog = deal.slPrice ? deal.slPrice.toFixed(6) : (deal.nextSOPrice !== null ? 'belum aktif' : '—');
          log('dca',
            `  ${symbol} | price=${price} avg=${deal.avgPrice.toFixed(6)} ` +
            `TP=${deal.tpPrice?.toFixed(6)} SL=${slLog} ` +
            `nextSO=${deal.nextSOPrice?.toFixed(6) ?? 'habis'} | SO ${deal.safetyOrdersFilled}/${config.dca.maxSafetyOrders}`
          );
        }
      } catch (err) {
        log('dca_error', `Evaluasi ${symbol} gagal: ${err.message}`);
      }

      await sleep(300);
    }

    await processPendingReopens();
  } finally {
    _loopBusy = false;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function startLoop() {
  stopLoop();
  const sec = config.trading.checkIntervalSec ?? 30;
  log('startup', `Loop cek deal aktif tiap ${sec} detik`);
  _loopTimer = setInterval(checkDeals, sec * 1000);
  checkDeals();
}

function stopLoop() {
  if (_loopTimer) { clearInterval(_loopTimer); _loopTimer = null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// TREND LOOP — analisa tren (informatif saja, terpisah dari loop DCA utama)
// ─────────────────────────────────────────────────────────────────────────────
function startTrendLoop() {
  stopTrendLoop();
  const min = config.trading.trendCheckIntervalMin ?? 30;
  log('startup', `Loop analisa tren tiap ${min} menit`);
  _trendTimer = setInterval(() => checkAllTrends(getActiveSymbols()), min * 60 * 1000);
  checkAllTrends(getActiveSymbols());
}

function stopTrendLoop() {
  if (_trendTimer) { clearInterval(_trendTimer); _trendTimer = null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS DISPLAY
// ─────────────────────────────────────────────────────────────────────────────
async function showStatus() {
  const stats = getStats();
  const deals = getActiveDeals();

  console.log('\n══════════════════════════════════════');
  console.log('  📊 STATUS DCA BOT');
  console.log('══════════════════════════════════════');
  console.log(`  Mode        : ${isDryRun ? '🧪 DRY RUN' : '💸 LIVE'}`);
  console.log(`  Deal aktif  : ${stats.activeDeals}/${config.trading.maxActiveDeals}`);
  console.log(`  Closed      : ${stats.closedCount}`);
  console.log(`  Total PnL   : ${stats.totalPnlUsdt >= 0 ? '+' : ''}${stats.totalPnlUsdt.toFixed(2)} USDT`);

  for (const [symbol, d] of Object.entries(deals)) {
    const price = await getCurrentPrice(symbol).catch(() => null);
    const pnl   = price ? ((price - d.avgPrice) / d.avgPrice * 100) : null;
    console.log(`\n  ${symbol}`);
    console.log(`    avg=${d.avgPrice.toFixed(6)} now=${price ?? '—'} PnL=${pnl !== null ? pnl.toFixed(2) + '%' : '—'}`);
    console.log(`    SO ${d.safetyOrdersFilled}/${config.dca.maxSafetyOrders} | nextSO=${d.nextSOPrice?.toFixed(6) ?? 'habis'}`);
    const slLog = d.slPrice ? d.slPrice.toFixed(6) : (d.nextSOPrice !== null ? 'belum aktif' : '—');
    console.log(`    TP=${d.tpPrice?.toFixed(6)} SL=${slLog}`);
  }
  const pending = getPendingReopens();
  const pendingSyms = Object.keys(pending);
  console.log(`\n  Auto Reopen : ${config.trading.reopenAfterClose ? 'ON' : 'OFF'} (cooldown ${config.trading.cooldownAfterCloseMin ?? 5} menit)`);
  if (pendingSyms.length) {
    console.log('  Menunggu reopen:');
    for (const s of pendingSyms) {
      const sisaMin = Math.max(0, Math.round((pending[s].readyAt - Date.now()) / 60000));
      console.log(`    ${s} — sisa ~${sisaMin} menit`);
    }
  }
  console.log(`  Cek Tren    : EMA${config.trading.trendEmaPeriod ?? 21} @ ${(config.trading.trendTimeframe ?? '1h').toUpperCase()}, tiap ${config.trading.trendCheckIntervalMin ?? 30} menit`);
  console.log('══════════════════════════════════════\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// REPL
// ─────────────────────────────────────────────────────────────────────────────
function startREPL() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '\n[dca-bot] > ' });
  console.log('\n📖 Perintah: status | start SYMBOL | close SYMBOL | untrack SYMBOL | reopen on/off | stop | help\n');
  rl.prompt();

  rl.on('line', async (line) => {
    const [cmd, arg] = line.trim().split(/\s+/);
    switch ((cmd || '').toLowerCase()) {
      case 'status': await showStatus(); break;
      case 'start':
        if (!arg) { console.log('Format: start SYMBOL'); break; }
        console.log(await startDeal(arg.toUpperCase())); break;
      case 'close':
        if (!arg) { console.log('Format: close SYMBOL'); break; }
        console.log(await closeDealManual(arg.toUpperCase())); break;
      case 'untrack':
        if (!arg) { console.log('Format: untrack SYMBOL  (tandai selesai TANPA sell dari bot, PnL tidak dihitung)'); break; }
        console.log(await closeDealUntrack(arg.toUpperCase())); break;
      case 'reopen':
        if (!arg || !['on', 'off'].includes(arg.toLowerCase())) { console.log('Format: reopen on | reopen off'); break; }
        saveConfig({ trading: { reopenAfterClose: arg.toLowerCase() === 'on' } });
        console.log(`🔁 Auto Reopen sekarang: ${config.trading.reopenAfterClose ? 'ON' : 'OFF'}`);
        break;
      case 'stop': stopLoop(); stopTrendLoop(); stopTelegramPolling(); process.exit(0); break;
      case 'help':
        console.log('  status | start SYMBOL | close SYMBOL | untrack SYMBOL | reopen on/off | stop'); break;
      default: console.log(`❓ Perintah tidak dikenal: "${cmd}"`);
    }
    rl.prompt();
  });
  rl.on('close', () => process.exit(0));
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  DCA Bot — Safety Order (ala 3Commas)            ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Mode: ${isDryRun ? '🧪 DRY RUN' : '💸 LIVE TRADING'}`);
  console.log('');

  if (!isDryRun) {
    log('startup', 'Mengecek koneksi Bitget API...');
    const conn = await testConnection();
    if (!conn.ok) { log('startup_error', `Koneksi API gagal: ${conn.error}`); process.exit(1); }
    log('startup', `✅ Koneksi OK | ${conn.assets} aset ditemukan`);
  } else {
    log('startup', '🧪 DRY RUN mode - API connection skipped');
  }

  const d = config.dca;
  log('startup', `Config DCA:`);
  log('startup', `  Base order   : ${d.baseOrderSize} USDT`);
  log('startup', `  Safety order : ${d.safetyOrderSize} USDT x${d.safetyOrderVolumeScale} tiap step | max ${d.maxSafetyOrders}`);
  log('startup', `  Deviasi SO   : ${d.priceDeviationPercent}% x${d.safetyOrderStepScale} tiap step`);
  log('startup', `  TP           : ${d.takeProfitPercent}% (basis: ${d.takeProfitBasis})`);
  log('startup', `  SL           : ${d.stopLossEnabled ? d.stopLossPercent + '% (basis: ' + d.stopLossBasis + ')' : 'nonaktif'}`);
  log('startup', `  Max deal     : ${config.trading.maxActiveDeals}`);

  await notifyStartup(isDryRun, config);

  if (args.includes('--list-only')) { await showStatus(); process.exit(0); }

  startLoop();
  startTrendLoop();

  startTelegramPolling({ startDeal, closeDealManual, closeDealUntrack });

  startApiServer({ startDeal, closeDealManual, closeDealUntrack });

  if (process.stdin.isTTY) startREPL();
  else log('startup', 'Non-TTY mode - berjalan sebagai daemon');
}

main().catch(err => { log('fatal', err.message); process.exit(1); });
