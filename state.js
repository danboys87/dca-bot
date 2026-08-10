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
      return s;
    }
  } catch (err) {
    log('state_error', `Gagal baca state: ${err.message}`);
  }
  return { deals: {}, closedDeals: [], totalPnlUsdt: 0, pendingReopens: {} };
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
  delete _state.deals[symbol];
  saveLocal(_state);

  log('state', `📁 Deal ditutup: ${symbol} @ ${exitPrice} | PnL=${pnlPct.toFixed(2)}% (${pnlUsdt >= 0 ? '+' : ''}${pnlUsdt.toFixed(2)} USDT) | reason=${reason}`);
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
