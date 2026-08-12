/**
 * Trend Monitor — analisa tren per symbol yang punya deal aktif.
 * Metode: SINGLE EMA — status ditentukan dari posisi harga terhadap 1 garis EMA.
 * Timeframe & periode EMA diambil dari config.trading (trendTimeframe, trendEmaPeriod)
 * biar gampang dituning tanpa edit kode.
 *
 * PENTING: modul ini SIFATNYA INFORMATIF SAJA.
 * Tidak mempengaruhi keputusan buka deal, Safety Order, Take Profit, atau Stop Loss —
 * itu semua tetap murni dari dcaEngine.js. Modul ini cuma memantau & kasih notifikasi
 * kalau ada indikasi tren berubah (bullish/bearish), biar user bisa ambil
 * keputusan sendiri (misal close manual, atau tunggu saja).
 */
import { getCandles } from './bitget.js';
import { log } from './logger.js';
import { config } from './config.js';
import { getTrendStatus, setTrendStatus } from './state.js';
import { notifyTrendChange } from './telegram.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function ema(values, period) {
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
  }
  return prev;
}

/**
 * Hitung status tren dari candle terbaru utk 1 symbol.
 * Timeframe & periode EMA dibaca fresh dari config tiap kali dipanggil (bukan hardcode),
 * jadi bisa diubah lewat dashboard/user-config.json tanpa restart.
 * Status: 'bullish' (harga > EMA), 'bearish' (harga < EMA), 'netral' (persis di garis EMA).
 * Return: { status, price, ema, period, timeframe } atau null kalau data kurang.
 */
export async function analyzeTrend(symbol) {
  const t         = config.trading;
  const timeframe = t.trendTimeframe ?? '1h';
  const period    = t.trendEmaPeriod ?? 21;

  const candles = await getCandles(symbol, timeframe, period + 50);
  if (!candles || candles.length < period + 10) {
    log('trend_warn', `Data candle ${symbol} (${timeframe}) tidak cukup utk analisa tren (dapat ${candles?.length ?? 0}, butuh min ${period + 10})`);
    return null;
  }

  // Bitget mengembalikan candle terurut ascending (lama → baru). Index [4] = close price.
  const closes = candles.map(c => parseFloat(c[4]));
  const price  = closes[closes.length - 1];
  const emaVal = ema(closes, period);

  let status = 'netral';
  if (price > emaVal) status = 'bullish';
  else if (price < emaVal) status = 'bearish';

  return { status, price, ema: emaVal, period, timeframe };
}

/**
 * Cek tren utk 1 symbol, bandingkan dgn status tersimpan sebelumnya.
 * Kalau berubah → update state + kirim notifikasi. Kalau sama → diam saja (no spam).
 */
export async function checkTrendForSymbol(symbol) {
  try {
    const result = await analyzeTrend(symbol);
    if (!result) return;

    const prev = getTrendStatus(symbol); // null kalau belum pernah dicek sebelumnya
    log('trend',
      `${symbol} ${result.timeframe} | status=${result.status} price=${result.price} EMA${result.period}=${result.ema.toFixed(6)}`
    );

    if (prev && prev !== result.status) {
      log('trend', `🔄 ${symbol} tren berubah: ${prev} → ${result.status}`);
      await notifyTrendChange(symbol, prev, result.status, result.price, result.timeframe);
    }

    setTrendStatus(symbol, result.status);
  } catch (err) {
    log('trend_error', `Analisa tren ${symbol} gagal: ${err.message}`);
  }
}

/**
 * Dipanggil berkala dari index.js — cek tren utk semua symbol yang sedang punya deal aktif.
 */
export async function checkAllTrends(symbols) {
  for (const symbol of symbols) {
    await checkTrendForSymbol(symbol);
    await sleep(300); // jaga rate limit Bitget
  }
}
