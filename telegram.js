/**
 * Telegram Notifications — DCA Bot
 */
import { log } from './logger.js';

const getToken  = () => process.env.TELEGRAM_BOT_TOKEN;
const getChatId = () => process.env.TELEGRAM_CHAT_ID;
const getBase   = () => { const t = getToken(); return t ? `https://api.telegram.org/bot${t}` : null; };

export function isEnabled() { return !!(getToken() && getChatId()); }

async function send(text) {
  if (!isEnabled()) return;
  try {
    await fetch(`${getBase()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: getChatId(), text, parse_mode: 'HTML' }),
    });
  } catch (err) {
    log('telegram_error', `Gagal kirim: ${err.message}`);
  }
}

function slLabel(deal) {
  if (deal.slPrice) return deal.slPrice.toFixed(6);
  return deal.nextSOPrice !== null ? 'belum aktif (masih ada slot SO)' : '—';
}

function tpLabel(deal) {
  if (deal.tpPriceBase != null && deal.tpPriceAverage != null) {
    return `${deal.tpPrice?.toFixed(6)} (base: ${deal.tpPriceBase.toFixed(6)} | avg: ${deal.tpPriceAverage.toFixed(6)})`;
  }
  return deal.tpPrice?.toFixed(6) ?? '—';
}

export async function notifyDealOpened(deal) {
  await send(
    `🟢 <b>Deal Dibuka</b> — ${deal.symbol}\n` +
    `Base order: ${deal.orders[0].qty} @ ${deal.orders[0].price} (${deal.orders[0].budget} USDT)\n` +
    `TP: ${tpLabel(deal)} | SL: ${slLabel(deal)}\n` +
    `SO berikutnya @ ${deal.nextSOPrice?.toFixed(6) ?? '—'}`
  );
}

export async function notifySafetyOrder(deal, step) {
  await send(
    `➕ <b>Safety Order ${step} Terisi</b> — ${deal.symbol}\n` +
    `Avg price baru: ${deal.avgPrice.toFixed(6)} | Total qty: ${deal.totalQty}\n` +
    `TP baru: ${tpLabel(deal)} | SL: ${slLabel(deal)}\n` +
    `SO berikutnya @ ${deal.nextSOPrice?.toFixed(6) ?? '(kuota SO habis — SL sekarang aktif)'}`
  );
}

export async function notifyDealClosed(closed) {
  const emoji = closed.pnlPct >= 0 ? '🟢' : '🔴';
  const sign  = closed.pnlPct >= 0 ? '+' : '';
  const labels = { take_profit: '🎯 Take Profit', stop_loss: '🛑 Stop Loss', manual_close: '🖐 Manual Close' };
  await send(
    `${emoji} <b>Deal Ditutup</b> — ${closed.symbol}\n` +
    `📌 ${labels[closed.reason] || closed.reason}\n` +
    `Avg entry: ${closed.avgPrice.toFixed(6)} → Exit: ${closed.exitPrice.toFixed(6)}\n` +
    `PnL: ${sign}${closed.pnlPct.toFixed(2)}% (${sign}${closed.pnlUsdt.toFixed(2)} USDT)\n` +
    `Safety order terpakai: ${closed.safetyOrdersFilled}`
  );
}

export async function notifyError(message) { await send(`⚠️ <b>DCA Bot Error</b>\n${message}`); }

export async function notifyStartup(dryRun, cfg) {
  await send(
    `🚀 <b>DCA Bot Aktif</b>\n` +
    `Mode: ${dryRun ? '🧪 DRY RUN' : '💸 LIVE TRADING'}\n` +
    `Base order: ${cfg.dca.baseOrderSize} USDT | Safety order: ${cfg.dca.safetyOrderSize} USDT x${cfg.dca.maxSafetyOrders}\n` +
    `Deviasi SO: ${cfg.dca.priceDeviationPercent}% | TP: ${cfg.dca.takeProfitPercent}% (basis: ${cfg.dca.takeProfitBasis})\n` +
    `SL: ${cfg.dca.stopLossEnabled ? cfg.dca.stopLossPercent + '% (basis: ' + cfg.dca.stopLossBasis + ')' : 'nonaktif'}\n` +
    `Max deal bersamaan: ${cfg.trading.maxActiveDeals}`
  );
}
