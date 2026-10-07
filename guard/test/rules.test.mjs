import assert from 'node:assert/strict';
import test from 'node:test';

import { parse } from '../src/money.js';
import { DEFAULT_LIMITS, DEFAULT_SYMBOLS, check, validateLimits, validateSymbols } from '../src/rules.js';

const NOW = Date.parse('2026-10-08T12:00:30Z');

function ctx(over = {}) {
  return {
    halted: false,
    symbols: [...DEFAULT_SYMBOLS],
    limits: { ...DEFAULT_LIMITS },
    cash: parse('10000'),
    reservedCash: 0n,
    pos: {},
    reservedQty: {},
    pendingBuy: {},
    prices: { BTCUSDT: parse('65000'), ETHUSDT: parse('2500') },
    priceTime: { BTCUSDT: NOW - 30_000, ETHUSDT: NOW - 30_000 },
    equity: parse('10000'),
    dayStartEquity: parse('10000'),
    startCash: parse('10000'),
    acceptedTimes: [],
    now: NOW,
    ...over,
  };
}

const buy = (usdt, symbol = 'BTCUSDT') => ({ symbol, side: 'buy', quote: parse(usdt) });
const sell = (qty, symbol = 'BTCUSDT') => ({ symbol, side: 'sell', qty: parse(qty) });

test('a normal buy passes', () => {
  assert.deepEqual(check(buy('500'), ctx()), { ok: true });
});

test('halted blocks everything, sells too', () => {
  assert.equal(check(buy('100'), ctx({ halted: true })).rule, 'halted');
  assert.equal(check(sell('0.1'), ctx({ halted: true, pos: { BTCUSDT: parse('1') } })).rule, 'halted');
});

test('only whitelisted symbols', () => {
  assert.equal(check(buy('100', 'PEPEUSDT'), ctx()).rule, 'symbol');
});

test('stale or missing price blocks', () => {
  assert.equal(check(buy('100'), ctx({ priceTime: { BTCUSDT: NOW - 121_000 } })).rule, 'stale_price');
  assert.equal(check(buy('100', 'SOLUSDT'), ctx()).rule, 'stale_price');
  assert.equal(check(buy('100'), ctx({ equity: null })).rule, 'stale_price');
});

test('min and max order size', () => {
  assert.equal(check(buy('9.99'), ctx()).rule, 'min_order');
  assert.equal(check(buy('1000'), ctx()).ok, true, 'exactly 10% is fine');
  assert.equal(check(buy('1000.01'), ctx()).rule, 'max_order');
});

test('cash includes the fee and pending buys', () => {
  const c = ctx({ cash: parse('600'), equity: parse('10000') });
  assert.equal(check(buy('600'), c).rule, 'cash', 'fee does not fit');
  assert.equal(check(buy('500'), ctx({ cash: parse('1000'), reservedCash: parse('600') })).rule, 'cash');
});

test('one coin at most 30% of equity, pending buys count', () => {
  const c = ctx({ pos: { BTCUSDT: parse('0.04') }, pendingBuy: { BTCUSDT: parse('400') } });
  // 0.04 × 65000 = 2600 held + 400 pending + 100 = 3100 > 3000
  assert.equal(check(buy('100'), c).rule, 'max_symbol');
  assert.equal(check(buy('100', 'ETHUSDT'), c).ok, true);
});

test('daily loss: buys stop, sells still go', () => {
  const c = ctx({ equity: parse('9500'), dayStartEquity: parse('10000'), pos: { BTCUSDT: parse('0.01') } });
  assert.equal(check(buy('100'), c).rule, 'daily_loss');
  assert.equal(check(sell('0.01'), c).ok, true);
  assert.equal(check(buy('100'), ctx({ equity: parse('9500.01') })).ok, true);
});

test('max loss halts at 70% of the start', () => {
  assert.equal(check(buy('100'), ctx({ equity: parse('7000') })).rule, 'max_loss');
  assert.equal(check(sell('0.01'), ctx({ equity: parse('7000'), pos: { BTCUSDT: parse('1') } })).rule, 'max_loss');
});

test('rate limits count accepted orders per hour and per UTC day', () => {
  const hour = Array.from({ length: 12 }, (_, i) => NOW - i * 60_000);
  assert.equal(check(buy('100'), ctx({ acceptedTimes: hour })).rule, 'rate_hour');
  const old = Array.from({ length: 12 }, (_, i) => NOW - 3600_000 - i * 60_000);
  assert.equal(check(buy('100'), ctx({ acceptedTimes: old })).ok, true);
  const day = Array.from({ length: 60 }, (_, i) => Date.parse('2026-10-08T00:00:00Z') + i * 60_000);
  assert.equal(check(buy('100'), ctx({ acceptedTimes: day })).rule, 'rate_day');
  const yesterday = Array.from({ length: 60 }, (_, i) => Date.parse('2026-10-07T10:00:00Z') + i * 60_000);
  assert.equal(check(buy('100'), ctx({ acceptedTimes: yesterday })).ok, true);
});

test('sells: no more than you hold, dust only if closing all', () => {
  const c = ctx({ pos: { BTCUSDT: parse('0.01') }, reservedQty: { BTCUSDT: parse('0.004') } });
  assert.equal(check(sell('0.0061'), c).rule, 'no_position');
  assert.equal(check(sell('0.006'), c).ok, true);
  assert.equal(check(sell('0.0001'), c).rule, 'min_order', '0.0001 × 65000 = 6.5 USDT');
  const dust = ctx({ pos: { BTCUSDT: parse('0.0001') } });
  assert.equal(check(sell('0.0001'), dust).ok, true, 'closing the whole position is fine');
});

test('bad input', () => {
  assert.equal(check({ symbol: 'BTCUSDT', side: 'short', quote: parse('1') }, ctx()).rule, 'bad_input');
  assert.equal(check({ symbol: 'BTCUSDT', side: 'buy' }, ctx()).rule, 'bad_input');
  assert.equal(check({ symbol: 'BTCUSDT', side: 'sell', qty: 0n }, ctx({ pos: { BTCUSDT: 1n } })).rule, 'bad_input');
});

test('limits and symbols validation', () => {
  assert.deepEqual(validateLimits({ ...DEFAULT_LIMITS }), { ...DEFAULT_LIMITS });
  assert.throws(() => validateLimits({ ...DEFAULT_LIMITS, max_order_pct: 0 }));
  assert.throws(() => validateLimits({ ...DEFAULT_LIMITS, max_symbol_pct: 101 }));
  assert.throws(() => validateLimits({ ...DEFAULT_LIMITS, max_orders_per_hour: 1.5 }));
  assert.throws(() => validateLimits({ ...DEFAULT_LIMITS, leverage: 10 }));
  assert.deepEqual(validateSymbols(['BTCUSDT', 'BTCUSDT']), ['BTCUSDT']);
  assert.throws(() => validateSymbols(['btcusdt']));
  assert.throws(() => validateSymbols([]));
});
