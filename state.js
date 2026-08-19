/**
 * State — menyimpan deal DCA aktif & history
 */
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from './logger.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = process.env.RAILWAY_ENVIRONMENT
  ? '/tmp/dca-state.json'
  : path.join(__dirname, 'state.json');

function loadLocal() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (!s.pendingReopens) s.pendingReopens = {}; // backward-compat state.json lama
      if (!s.trendStatus)    s.trendStatus    = {}; // backward-compat state.json lama
      if (s.compoundingPool === undefined)    s.compoundingPool    = 0;
      if (s.compoundingNotified === undefined) s.compoundingNotified = false;
      return s;
    }
  } catch (err) {
    log('state_error', `Gagal baca state: ${err.message}`);
  }
  return {
    deals: {}, closedDeals: [], totalPnlUsdt: 0, pendingReopens: {}, trendStatus: {},
    compoundingPool: 0, compoundingNotified: false,
  };
}

function saveLocal(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log('state_error', `Gagal simpan state: ${err.message}`);
  }
}

let _state = loadLocal();

export function hasActiveDeal(symbol) { return !!_state.deals[symbol]; }
export function getDeal(symbol)       { return _state.deals[symbol] || null; }
export function getActiveDeals()      { return _state.deals; }
export function getActiveSymbols()    { return Object.keys(_state.deals); }

export function startDeal(symbol, { qty, price, budget, orderId }) {
  const deal = {
    symbol,
    status:            'active',
    baseOrderPrice:    price,
    avgPrice:          price,
    totalQty:          qty,
    totalSpent:        qty * price,
    safetyOrdersFilled: 0,
    nextSOPrice:       null,
    nextSOSize:        null,
    tpPrice:           null,
    slPrice:           null,
    tpHold:            false, // TP Hold — kalau true, TP dilewati sementara (SO & SL tetap jalan normal)
    openedAt:          new Date().toISOString(),
    orders: [
      { tag: 'base', qty, price, budget, orderId, filledAt: new Date().toISOString() },
    ],
  };
  _state.deals[symbol] = deal;
  saveLocal(_state);
  log('state', `📂 Deal dibuka: ${symbol} @ ${price} budget=${budget}`);
  return deal;
}

export function addSafetyOrderFill(symbol, { step, qty, price, budget, orderId }) {
  const deal = _state.deals[symbol];
  if (!deal) return null;
  deal.orders.push({ tag: `so${step}`, qty, price, budget, orderId, filledAt: new Date().toISOString() });
  saveLocal(_state);
  log('state', `➕ SO${step} terisi: ${symbol} @ ${price} budget=${budget}`);
  return deal;
}

export function updateDealCalc(symbol, patch) {
  const deal = _state.deals[symbol];
  if (!deal) return null;
  Object.assign(deal, patch);
  saveLocal(_state);
  return deal;
}

/**
 * TP Hold — bekukan sementara logic Take Profit utk 1 deal. Selama hold aktif,
 * SO & SL TETAP jalan normal seperti biasa; cuma TP yang dilewati. Dipakai kalau
 * user mau nunggu kenaikan lebih tinggi dari target TP normal sebelum jual.
 */
export function setTpHold(symbol, hold) {
  const deal = _state.deals[symbol];
  if (!deal) return null;
  deal.tpHold = !!hold;
  saveLocal(_state);
  log('state', `${hold ? '⏸' : '▶'} TP Hold ${hold ? 'diaktifkan' : 'dinonaktifkan'}: ${symbol}`);
  return deal;
}

/**
 * Close deal DENGAN harga exit asli (TP/SL/Manual Close via bot).
 * pnlUsdt hasil deal ini SENGAJA ditambahkan ke compoundingPool — itu "profit"
 * (atau rugi, kalau negatif) yang jadi basis fitur compounding.
 */
export function closeDeal(symbol, { exitPrice, reason }) {
  const deal = _state.deals[symbol];
  if (!deal) return null;

  const pnlUsdt = (exitPrice - deal.avgPrice) * deal.totalQty;
  const pnlPct  = ((exitPrice - deal.avgPrice) / deal.avgPrice) * 100;

  const closed = {
    ...deal,
    status:    'closed',
    exitPrice,
    closedAt:  new Date().toISOString(),
    reason,
    pnlUsdt,
    pnlPct,
  };

  _state.closedDeals.push(closed);
  _state.totalPnlUsdt = (_state.totalPnlUsdt || 0) + pnlUsdt;
  _state.compoundingPool = (_state.compoundingPool || 0) + pnlUsdt;
  delete _state.deals[symbol];
  saveLocal(_state);

  log('state', `📁 Deal ditutup: ${symbol} @ ${exitPrice} | PnL=${pnlPct.toFixed(2)}% (${pnlUsdt >= 0 ? '+' : ''}${pnlUsdt.toFixed(2)} USDT) | reason=${reason}`);
  return closed;
}

/**
 * Untrack — dipakai kalau user JUAL SENDIRI di luar bot (manual di app exchange).
 * BEDA dari closeDeal(): tidak ada exitPrice/eksekusi order, dan PnL SENGAJA
 * tidak dihitung/ditambahkan ke totalPnlUsdt ATAU compoundingPool — supaya statistik
 * & compounding bot tetap murni mencerminkan performa keputusan OTOMATIS bot sendiri.
 */
export function untrackDeal(symbol) {
  const deal = _state.deals[symbol];
  if (!deal) return null;

  const closed = {
    ...deal,
    status:    'closed',
    exitPrice: null,
    closedAt:  new Date().toISOString(),
    reason:    'manual_untracked',
    pnlUsdt:   null,
    pnlPct:    null,
  };

  _state.closedDeals.push(closed);
  // totalPnlUsdt & compoundingPool SENGAJA TIDAK diubah di sini.
  delete _state.deals[symbol];
  saveLocal(_state);

  log('state', `📁 Deal di-untrack (manual, di luar bot): ${symbol} | SO terpakai=${deal.safetyOrdersFilled} | PnL TIDAK dihitung ke statistik/compounding`);
  return closed;
}

// ── Auto Reopen scheduling ──────────────────────────────────────────────────
export function schedulePendingReopen(symbol, closedAt, cooldownMin) {
  _state.pendingReopens[symbol] = { readyAt: closedAt + cooldownMin * 60 * 1000, closedAt };
  saveLocal(_state);
}

export function clearPendingReopen(symbol) {
  delete _state.pendingReopens[symbol];
  saveLocal(_state);
}

export function getPendingReopens() { return _state.pendingReopens; }

// ── Trend status (dipakai trendMonitor.js) ──────────────────────────────────
export function getTrendStatus(symbol) {
  return _state.trendStatus?.[symbol] || null;
}

export function setTrendStatus(symbol, status) {
  if (!_state.trendStatus) _state.trendStatus = {};
  _state.trendStatus[symbol] = status;
  saveLocal(_state);
}

// ── Compounding pool (dipakai compounding.js) ───────────────────────────────
export function getCompoundingPool() { return _state.compoundingPool || 0; }

export function resetCompoundingPool() {
  _state.compoundingPool = 0;
  saveLocal(_state);
}

export function getCompoundingNotified() { return !!_state.compoundingNotified; }

export function setCompoundingNotified(val) {
  _state.compoundingNotified = !!val;
  saveLocal(_state);
}

export function getStats() {
  return {
    activeDeals: Object.keys(_state.deals).length,
    closedCount: _state.closedDeals.length,
    totalPnlUsdt: _state.totalPnlUsdt || 0,
  };
}

export function getClosedDeals(limit = 50) {
  return _state.closedDeals.slice(-limit).reverse();
}

export function reload() { _state = loadLocal(); }
