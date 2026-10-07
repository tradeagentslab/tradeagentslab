// The locks. One pure function decides if an order may go through.
// The local guard and the arena engine both call `check`, so a season's rules
// are the same code everywhere.

import { buyReserve } from './book.js';
import { bps, mul, parse, show } from './money.js';

export const DEFAULT_SYMBOLS = Object.freeze([
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT',
]);

export const DEFAULT_LIMITS = Object.freeze({
  max_order_pct: 10, // one order ≤ 10% of equity
  min_order_usdt: 10, // smallest order
  max_symbol_pct: 30, // one coin ≤ 30% of equity
  daily_loss_pct: 5, // down 5% since 00:00 UTC → sells only for the rest of the day
  max_loss_pct: 30, // equity at 70% of the start → halt
  max_orders_per_hour: 12,
  max_orders_per_day: 60,
  max_price_age_sec: 120, // no trading on prices older than this
});

const PCT_KEYS = ['max_order_pct', 'max_symbol_pct', 'daily_loss_pct', 'max_loss_pct'];
const INT_KEYS = ['max_orders_per_hour', 'max_orders_per_day', 'max_price_age_sec'];

/** Throws if a limits object is not usable. Returns a clean copy. */
export function validateLimits(limits) {
  const out = {};
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const v = limits?.[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new RangeError(`limit ${key} must be a positive number`);
    }
    if (PCT_KEYS.includes(key) && v > 100) throw new RangeError(`limit ${key} must be ≤ 100`);
    if (INT_KEYS.includes(key) && !Number.isInteger(v)) throw new RangeError(`limit ${key} must be a whole number`);
    out[key] = v;
  }
  const extra = Object.keys(limits).filter((k) => !(k in DEFAULT_LIMITS));
  if (extra.length) throw new RangeError(`unknown limit: ${extra.join(', ')}`);
  return out;
}

export const SYMBOL_RE = /^[A-Z0-9]{2,12}USDT$/;

/** Throws if a symbol list is not usable. */
export function validateSymbols(symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) throw new RangeError('symbols must be a non-empty list');
  for (const s of symbols) if (!SYMBOL_RE.test(s)) throw new RangeError(`bad symbol: ${s}`);
  return [...new Set(symbols)];
}

const HOUR = 3600_000;
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

const no = (rule, message) => ({ ok: false, rule, message });

/**
 * May this order go through?
 *
 * order: { symbol, side: 'buy' | 'sell', quote?: units (buys), qty?: units (sells) }
 * ctx: {
 *   halted, symbols, limits,
 *   cash, reservedCash, pos: { sym: units }, reservedQty: { sym: units },
 *   pendingBuy: { sym: units of quote waiting to fill },
 *   prices: { sym: units }, priceTime: { sym: ms },
 *   equity, dayStartEquity (units or null), startCash,
 *   acceptedTimes: [ms of accepted orders], now: ms,
 * }
 * Returns { ok: true } or { ok: false, rule, message }. `rule` is a stable id.
 */
export function check(order, ctx) {
  const L = ctx.limits;
  const { symbol, side } = order;

  if (ctx.halted) return no('halted', 'Trading is halted. Only a person can resume it (tal resume).');
  if (!ctx.symbols.includes(symbol)) {
    return no('symbol', `${symbol} is not on the list: ${ctx.symbols.join(', ')}.`);
  }
  if (side !== 'buy' && side !== 'sell') return no('bad_input', 'side must be buy or sell.');

  const price = ctx.prices[symbol];
  const priceTime = ctx.priceTime[symbol];
  if (price == null || priceTime == null || ctx.now - priceTime > L.max_price_age_sec * 1000) {
    return no('stale_price', `No fresh price for ${symbol}; not trading on old prices.`);
  }
  if (ctx.equity == null) return no('stale_price', 'Cannot value the account right now.');

  if (ctx.equity * 10000n <= ctx.startCash * (10000n - bps(L.max_loss_pct))) {
    return no('max_loss', `Equity is down ${L.max_loss_pct}% or more from the start. Trading halts.`);
  }

  const lastHour = ctx.acceptedTimes.filter((t) => ctx.now - t < HOUR).length;
  if (lastHour >= L.max_orders_per_hour) {
    return no('rate_hour', `At most ${L.max_orders_per_hour} orders per hour.`);
  }
  const today = utcDay(ctx.now);
  const todayCount = ctx.acceptedTimes.filter((t) => utcDay(t) === today).length;
  if (todayCount >= L.max_orders_per_day) {
    return no('rate_day', `At most ${L.max_orders_per_day} orders per UTC day.`);
  }

  const minOrder = parse(L.min_order_usdt);

  if (side === 'sell') {
    const qty = order.qty;
    if (typeof qty !== 'bigint' || qty <= 0n) return no('bad_input', 'Sell needs a positive qty.');
    const free = (ctx.pos[symbol] ?? 0n) - (ctx.reservedQty[symbol] ?? 0n);
    if (qty > free) return no('no_position', `You can sell at most ${show(free, 8)} ${symbol.slice(0, -4)}.`);
    if (mul(qty, price) < minOrder && qty !== free) {
      return no('min_order', `Orders must be at least ${L.min_order_usdt} USDT (selling everything is fine).`);
    }
    return { ok: true };
  }

  const quote = order.quote;
  if (typeof quote !== 'bigint' || quote <= 0n) return no('bad_input', 'Buy needs a positive usdt amount.');

  if (ctx.dayStartEquity != null
    && ctx.equity * 10000n <= ctx.dayStartEquity * (10000n - bps(L.daily_loss_pct))) {
    return no('daily_loss', `Down ${L.daily_loss_pct}% or more today (UTC). Sells only until 00:00 UTC.`);
  }
  if (quote < minOrder) return no('min_order', `Orders must be at least ${L.min_order_usdt} USDT.`);
  if (quote * 10000n > ctx.equity * bps(L.max_order_pct)) {
    return no('max_order', `One order can use at most ${L.max_order_pct}% of equity (${show(ctx.equity * bps(L.max_order_pct) / 10000n)} USDT now).`);
  }
  if (buyReserve(quote) > ctx.cash - ctx.reservedCash) {
    return no('cash', `Not enough free cash: ${show(ctx.cash - ctx.reservedCash)} USDT, fee included.`);
  }
  const after = mul(ctx.pos[symbol] ?? 0n, price) + (ctx.pendingBuy[symbol] ?? 0n) + quote;
  if (after * 10000n > ctx.equity * bps(L.max_symbol_pct)) {
    return no('max_symbol', `One coin can be at most ${L.max_symbol_pct}% of equity.`);
  }
  return { ok: true };
}
