/**
 * Executor — eksekusi order ke Bitget Spot (base order, safety order, close deal)
 */
import { placeOrder, getOrder, getAssetBalance, getCurrentPrice } from './bitget.js';
import { log, logTrade } from './logger.js';
import {
  startDeal, addSafetyOrderFill, updateDealCalc, closeDeal, getDeal,
} from './state.js';
import { recalcDeal } from './dcaEngine.js';
import { config } from './config.js';

const isDryRun = process.env.DRY_RUN === 'true';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getQtyDecimals(price) {
  if (price >= 10000) return 6;
  if (price >= 100)   return 4;
  if (price >= 1)     return 2;
  return 2;
}

async function calcQuantity(symbol, budget) {
  const price = await getCurrentPrice(symbol);
  if (!price || price <= 0) throw new Error(`Harga tidak valid untuk ${symbol}`);
  const decimals   = getQtyDecimals(price);
  const multiplier = Math.pow(10, decimals);
  const qty        = Math.floor((budget / price) * multiplier) / multiplier;
  return { price, qty };
}

async function marketBuy(symbol, budget) {
  const { price: refPrice, qty } = await calcQuantity(symbol, budget);
  if (qty <= 0) throw new Error(`Quantity <= 0 untuk ${symbol}`);

  if (isDryRun) {
    log('executor', `[DRY RUN] BUY ${symbol} qty=${qty} @ ${refPrice}`);
    return { price: refPrice, qty, orderId: `dryrun_${Date.now()}` };
  }

  const usdtBalance = await getAssetBalance('USDT');
  const available    = parseFloat(usdtBalance?.available || 0);
  const needed        = budget + (config.trading.gasReserve ?? 3);
  if (available < needed) throw new Error(`Saldo USDT tidak cukup: ${available} < ${needed}`);

  const order   = await placeOrder({ symbol, side: 'buy', orderType: 'market', size: budget });
  const orderId = order?.orderId;
  if (!orderId) throw new Error('Tidak ada orderId dari API');

  await sleep(1500);
  const detail    = await getOrder(orderId, symbol).catch(() => null);
  const fillPrice = detail ? parseFloat(detail.priceAvg || detail.fillPrice || refPrice) : refPrice;
  const fillQty   = detail ? parseFloat(detail.baseVolume || detail.fillSize || qty) : qty;

  return { price: fillPrice, qty: fillQty, orderId };
}

async function marketSellAll(symbol, quantity) {
  const currentPrice = await getCurrentPrice(symbol);
  if (!currentPrice) throw new Error(`Tidak bisa ambil harga ${symbol}`);

  if (isDryRun) {
    log('executor', `[DRY RUN] SELL ${symbol} qty=${quantity} @ ${currentPrice}`);
    return { price: currentPrice, qty: quantity };
  }

  const baseAsset = symbol.replace(config.trading.quoteAsset || 'USDT', '');
  const tokenBal  = await getAssetBalance(baseAsset);
  const available = parseFloat(tokenBal?.available || 0);
  const sellQty   = Math.floor(Math.min(quantity, available) * 100) / 100;
  if (sellQty <= 0) throw new Error(`Saldo ${baseAsset} tidak cukup: ${available}`);

  const order   = await placeOrder({ symbol, side: 'sell', orderType: 'market', size: sellQty });
  const orderId = order?.orderId;
  await sleep(1500);
  const detail    = await getOrder(orderId, symbol).catch(() => null);
  const fillPrice = detail ? parseFloat(detail.priceAvg || currentPrice) : currentPrice;

  return { price: fillPrice, qty: sellQty };
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function openDeal(symbol) {
  const budget = config.dca.baseOrderSize;
  log('executor', `🚀 Membuka deal ${symbol} | base order = ${budget} USDT`);
  const { price, qty, orderId } = await marketBuy(symbol, budget);

  const deal = startDeal(symbol, { qty, price, budget, orderId });
  recalcDeal(deal, config.dca);
  updateDealCalc(symbol, deal);

  logTrade({ side: 'buy', symbol, qty, price, tag: 'base' });
  return deal;
}

export async function fillSafetyOrder(symbol, step, budget) {
  log('executor', `➕ SO${step} ${symbol} | budget=${budget.toFixed(2)} USDT`);
  const { price, qty, orderId } = await marketBuy(symbol, budget);

  let deal = addSafetyOrderFill(symbol, { step, qty, price, budget, orderId });
  deal = recalcDeal(deal, config.dca);
  updateDealCalc(symbol, deal);

  logTrade({ side: 'buy', symbol, qty, price, tag: `so${step}` });
  return deal;
}

export async function closeDealMarket(symbol, reason) {
  const deal = getDeal(symbol);
  if (!deal) throw new Error(`Deal ${symbol} tidak ditemukan`);

  log('executor', `🔻 Menutup deal ${symbol} | reason=${reason} | qty=${deal.totalQty}`);
  const { price, qty } = await marketSellAll(symbol, deal.totalQty);

  logTrade({ side: 'sell', symbol, qty, price, tag: reason });
  return closeDeal(symbol, { exitPrice: price, reason });
}
