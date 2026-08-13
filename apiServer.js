/**
 * API Server — Dashboard REST Endpoints (DCA Bot)
 */
import http   from 'http';
import fs     from 'fs';
import path   from 'path';
import { fileURLToPath } from 'url';
import { log }             from './logger.js';
import { getCurrentPrice } from './bitget.js';
import { getStats, getActiveDeals, getClosedDeals, getTrendStatus } from './state.js';
import { config, saveConfig } from './config.js';
import { analyzeTrend } from './trendMonitor.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const PORT       = parseInt(process.env.DASHBOARD_PORT || '3001');
const API_SECRET = process.env.DASHBOARD_SECRET || '';

let _callbacks = {};
export function setApiCallbacks(cb) { _callbacks = cb; }

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type':                 'application/json',
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Secret',
  });
  res.end(JSON.stringify(data));
}

function err(res, msg, status = 400) { json(res, { ok: false, error: msg }, status); }

async function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } });
  });
}

function checkAuth(req) {
  if (!API_SECRET) return true;
  return req.headers['x-secret'] === API_SECRET;
}

function tailLog(lines = 150) {
  try {
    const today   = new Date().toISOString().slice(0, 10);
    const logFile = path.join(__dirname, 'logs', `dca-${today}.log`);
    if (!fs.existsSync(logFile)) return [];
    return fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-lines);
  } catch { return []; }
}

async function handle(req, res) {
  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const route  = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-Secret' });
    res.end(); return;
  }
  if (method === 'POST' && !checkAuth(req)) { err(res, 'Unauthorized', 401); return; }

  if (route === '/api/status' && method === 'GET') {
    const stats = getStats();
    const deals = getActiveDeals();
    const enriched = {};
    for (const [sym, d] of Object.entries(deals)) {
      const price = await getCurrentPrice(sym).catch(() => null);
      const pnlPct  = price ? ((price - d.avgPrice) / d.avgPrice * 100) : null;
      const pnlUsdt = price ? ((price - d.avgPrice) * d.totalQty) : null;
      enriched[sym] = { ...d, currentPrice: price, pnlPct, pnlUsdt, trendStatus: getTrendStatus(sym) };
    }
    json(res, {
      ok: true,
      stats,
      deals: enriched,
      config: { dca: config.dca, trading: config.trading, isDryRun: process.env.DRY_RUN === 'true' },
      serverTime: new Date().toISOString(),
    });
    return;
  }

  if (route === '/api/history' && method === 'GET') {
    // ?limit= opsional — default 200, dinaikkan dari 100 supaya perhitungan
    // PnL Harian di dashboard tidak kepotong kalau history sudah panjang.
    // Dibatasi max 2000 biar tidak berat kalau ada yang iseng minta limit gede.
    const requested = parseInt(url.searchParams.get('limit') || '200');
    const limit = Math.min(Math.max(requested || 200, 1), 2000);
    json(res, { ok: true, deals: getClosedDeals(limit) });
    return;
  }

  if (route === '/api/logs' && method === 'GET') {
    const n = parseInt(url.searchParams.get('n') || '150');
    json(res, { ok: true, logs: tailLog(n) });
    return;
  }

  if (route.startsWith('/api/price/') && method === 'GET') {
    const symbol = route.split('/').pop().toUpperCase();
    const price  = await getCurrentPrice(symbol).catch(() => null);
    json(res, { ok: true, symbol, price });
    return;
  }

  // Analisa tren fresh (live), TIDAK menimpa status tersimpan yang dipakai
  // background loop utk deteksi perubahan — murni utk tampilan "cek sekarang".
  if (route.startsWith('/api/trend/') && method === 'GET') {
    const symbol = route.split('/').pop().toUpperCase();
    try {
      const result = await analyzeTrend(symbol);
      if (!result) { err(res, `Data candle ${symbol} tidak cukup utk analisa tren`); return; }
      json(res, { ok: true, symbol, ...result });
    } catch (e) { err(res, e.message); }
    return;
  }

  if (route === '/api/config' && method === 'GET') { json(res, { ok: true, config }); return; }

  if (route === '/api/config' && method === 'POST') {
    const body = await readBody(req);
    try { saveConfig(body); json(res, { ok: true, config }); }
    catch (e) { err(res, e.message); }
    return;
  }

  if (route === '/api/start' && method === 'POST') {
    const { symbol } = await readBody(req);
    if (!symbol) { err(res, 'symbol required'); return; }
    try { json(res, await _callbacks.startDeal(symbol.toUpperCase())); }
    catch (e) { err(res, e.message); }
    return;
  }

  if (route === '/api/close' && method === 'POST') {
    const { symbol } = await readBody(req);
    if (!symbol) { err(res, 'symbol required'); return; }
    try { json(res, await _callbacks.closeDealManual(symbol.toUpperCase())); }
    catch (e) { err(res, e.message); }
    return;
  }

  // Close TANPA eksekusi order — user sudah jual sendiri di luar bot.
  // PnL deal ini TIDAK dihitung ke statistik (lihat state.js -> untrackDeal).
  if (route === '/api/untrack' && method === 'POST') {
    const { symbol } = await readBody(req);
    if (!symbol) { err(res, 'symbol required'); return; }
    try { json(res, await _callbacks.closeDealUntrack(symbol.toUpperCase())); }
    catch (e) { err(res, e.message); }
    return;
  }

  json(res, { ok: false, error: 'Route tidak ditemukan' }, 404);
}

export function startApiServer(callbacks) {
  setApiCallbacks(callbacks);
  const server = http.createServer(async (req, res) => {
    try { await handle(req, res); } catch (e) { err(res, e.message, 500); }
  });
  server.listen(PORT, () => {
    log('api_server', `✅ Dashboard API DCA berjalan di http://localhost:${PORT}`);
  });
  return server;
}
