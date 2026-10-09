// Baselines: three fixed, public rules that sit on the board as a yardstick.
// They obey the same locks and fill rule as every agent, call no AI model and use
// no keys. Each decision depends only on the account and public candles, so anyone
// can recompute it.

import { mul, parse } from '../money.js';

const DAY = 86_400_000;
const STEP_PCT = 9.9; // just under the 10%-per-order lock, so fees never push an order over it
const CAP_PCT = 30; // the one-coin lock
const NEAR_CAP_PCT = 29; // stop topping up once a coin is this close to the cap

export const BASELINES = Object.freeze({
  'baseline-hold': {
    name: 'Hold',
    model: 'Baseline: buy BTC, ETH, SOL to 30% each on day one, then hold',
  },
  'baseline-dca': {
    name: 'Daily DCA',
    model: 'Baseline: buy 1% of equity each of BTC and ETH every day at 00:00 UTC, up to 30% each',
  },
  'baseline-ma': {
    name: 'BTC 20-day MA',
    model: 'Baseline: hold 30% BTC while the daily close is above its 20-day average, else none',
  },
});

const pctOf = (part, whole) => (whole > 0n ? Number((part * 10_000n) / whole) / 100 : 0);
const usdt = (equity, pct) => (Number(equity) / 1e8) * (pct / 100);

/**
 * Orders a baseline places at minute `m` (decided on that minute's closes, filled
 * at the next minute's open). Returns [{ symbol, side, usdt | qty, reason }].
 *
 * ctx: { kind, m, startedAt (ms the agent began), book, closes (units), equity (units),
 *        daily(symbol, dayStartMs) → array of the 20 previous daily closes (strings) or undefined }
 */
export function baselineOrders({ kind, m, startedAt, book, closes, equity, daily }) {
  const held = (s) => pctOf(mul(book.pos[s] ?? 0n, closes[s]), equity);
  const buyUpTo = (s, targetPct, reason) => {
    const out = [];
    let have = held(s);
    while (targetPct - have >= 1) {
      const step = Math.min(STEP_PCT, targetPct - have);
      out.push({ symbol: s, side: 'buy', usdt: usdt(equity, step).toFixed(2), reason });
      have += step;
    }
    return out;
  };

  if (kind === 'baseline-hold') {
    if (m !== startedAt) return [];
    return ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].flatMap((s) => buyUpTo(s, NEAR_CAP_PCT, 'Baseline: buy and hold'));
  }

  const dayStart = m % DAY === 0;
  if (kind === 'baseline-dca') {
    if (!dayStart) return [];
    return ['BTCUSDT', 'ETHUSDT']
      .filter((s) => held(s) + 1 <= NEAR_CAP_PCT)
      .map((s) => ({ symbol: s, side: 'buy', usdt: usdt(equity, 1).toFixed(2), reason: 'Baseline: daily 1% buy' }));
  }

  if (kind === 'baseline-ma') {
    if (!dayStart && m !== startedAt) return [];
    const closesD = daily?.('BTCUSDT', m - (m % DAY));
    if (!closesD || closesD.length < 20) return [];
    const last = Number(closesD[closesD.length - 1]);
    const avg = closesD.slice(-20).reduce((a, c) => a + Number(c), 0) / 20;
    if (last > avg) return buyUpTo('BTCUSDT', NEAR_CAP_PCT, `Baseline: BTC daily close ${last} above its 20-day average ${avg.toFixed(2)}`);
    if ((book.pos.BTCUSDT ?? 0n) > 0n) {
      return [{ symbol: 'BTCUSDT', side: 'sell', qty: 'all', reason: `Baseline: BTC daily close ${last} below its 20-day average ${avg.toFixed(2)}` }];
    }
    return [];
  }
  return [];
}

export { CAP_PCT, parse };
