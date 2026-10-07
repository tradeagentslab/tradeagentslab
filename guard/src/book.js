// The paper account: cash plus positions, and the fill math.
// Same code runs on your machine and in the arena, so both get the same numbers.

import { ceilDiv, div, mul } from './money.js';

/** Fee per side in basis points: 10 = 0.1%. */
export const FEE_BPS = 10n;

const fee = (notional) => ceilDiv(notional * FEE_BPS, 10000n);

/** A market buy spending `quote` USDT at `price`: quantity rounds down, fee rounds up. */
export function buyAt(quote, price) {
  const qty = div(quote, price);
  const notional = mul(qty, price);
  const f = fee(notional);
  return { qty, notional, fee: f, cash: -(notional + f) };
}

/** A market sell of `qty` at `price`. */
export function sellAt(qty, price) {
  const notional = mul(qty, price);
  const f = fee(notional);
  return { qty, notional, fee: f, cash: notional - f };
}

/** Cash to set aside when a buy is accepted, so its fill can never overdraw. */
export function buyReserve(quote) {
  return quote + fee(quote);
}

export function newBook(startCash) {
  return { cash: startCash, pos: {} };
}

/** Apply a fill to a book in place. `f` holds units: { side, symbol, qty, notional, fee }. */
export function applyFill(book, f) {
  const held = book.pos[f.symbol] ?? 0n;
  if (f.side === 'buy') {
    book.cash -= f.notional + f.fee;
    book.pos[f.symbol] = held + f.qty;
  } else {
    if (f.qty > held) throw new RangeError(`sell ${f.qty} > held ${held} for ${f.symbol}`);
    book.cash += f.notional - f.fee;
    book.pos[f.symbol] = held - f.qty;
  }
  if (book.pos[f.symbol] === 0n) delete book.pos[f.symbol];
  if (book.cash < 0n) throw new RangeError('cash below zero');
  return book;
}

/** Value of one position at `price`. */
export function positionValue(book, symbol, price) {
  return mul(book.pos[symbol] ?? 0n, price);
}

/** Cash plus every position at `prices` ({ BTCUSDT: units }). Missing price → null. */
export function equity(book, prices) {
  let total = book.cash;
  for (const [symbol, qty] of Object.entries(book.pos)) {
    const price = prices[symbol];
    if (price === undefined || price === null) return null;
    total += mul(qty, price);
  }
  return total;
}
