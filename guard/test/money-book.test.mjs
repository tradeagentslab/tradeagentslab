import assert from 'node:assert/strict';
import test from 'node:test';

import { applyFill, buyAt, buyReserve, equity, newBook, sellAt } from '../src/book.js';
import { bps, ceilDiv, floorDiv, fmt, parse, show } from '../src/money.js';

test('parse and fmt round-trip', () => {
  assert.equal(parse('65000.01'), 6500001000000n);
  assert.equal(parse('0.00012'), 12000n);
  assert.equal(parse(100), 10000000000n);
  assert.equal(parse('-1.5'), -150000000n);
  assert.equal(parse('1.123456789'), 112345678n, 'extra decimals are cut');
  assert.equal(fmt(6500001000000n), '65000.01000000');
  assert.equal(fmt(-150000000n), '-1.50000000');
  assert.equal(fmt(10000000000n, { trim: true }), '100');
  assert.equal(fmt(0n, { trim: true }), '0');
  assert.throws(() => parse('1e5'));
  assert.throws(() => parse(Number.NaN));
});

test('integer helpers', () => {
  assert.equal(floorDiv(7n, 2n), 3n);
  assert.equal(floorDiv(-7n, 2n), -4n);
  assert.equal(ceilDiv(7n, 2n), 4n);
  assert.equal(ceilDiv(-7n, 2n), -3n);
  assert.equal(bps(5), 500n);
  assert.equal(bps(2.5), 250n);
  assert.equal(show(parse('-12.3456')), '-12.34');
  assert.equal(show(parse('9999.999')), '9999.99');
});

test('buy: quantity rounds down, fee rounds up, never overdraws the reserve', () => {
  const quote = parse('100');
  const price = parse('65000.01');
  const f = buyAt(quote, price);
  assert.equal(f.qty, parse('0.00153846'));
  assert.equal(f.notional, parse('99.99991538'));
  assert.equal(f.fee, parse('0.09999992'));
  assert.ok(-f.cash <= buyReserve(quote));
});

test('sell: fee comes out of the proceeds', () => {
  const f = sellAt(parse('0.5'), parse('3000'));
  assert.equal(f.notional, parse('1500'));
  assert.equal(f.fee, parse('1.5'));
  assert.equal(f.cash, parse('1498.5'));
});

test('book keeps cash and positions exact over many trades', () => {
  const book = newBook(parse('10000'));
  const price = parse('0.12345678');
  for (let i = 0; i < 50; i++) {
    const b = buyAt(parse('37.5'), price);
    applyFill(book, { side: 'buy', symbol: 'DOGEUSDT', ...b });
  }
  const held = book.pos.DOGEUSDT;
  const s = sellAt(held, price);
  applyFill(book, { side: 'sell', symbol: 'DOGEUSDT', ...s });
  assert.equal(book.pos.DOGEUSDT, undefined);
  assert.ok(book.cash < parse('10000'), 'fees cost money');
  assert.ok(book.cash > parse('9996'), 'but only about 0.2% of 1875 USDT');
});

test('equity needs a price for every position', () => {
  const book = newBook(parse('1000'));
  applyFill(book, { side: 'buy', symbol: 'BTCUSDT', ...buyAt(parse('100'), parse('50000')) });
  assert.equal(equity(book, {}), null);
  const e = equity(book, { BTCUSDT: parse('55000') });
  assert.ok(e > parse('1009') && e < parse('1010'));
});

test('selling more than held throws', () => {
  const book = newBook(parse('1000'));
  assert.throws(() => applyFill(book, { side: 'sell', symbol: 'BTCUSDT', ...sellAt(parse('1'), parse('1')) }));
});
