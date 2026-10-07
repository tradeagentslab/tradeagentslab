// Test helpers: a clock you move by hand and a market you set by hand. No network.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultConfig, saveConfig } from '../src/config.js';
import { Guard } from '../src/guard.js';

export const T0 = Date.parse('2026-10-08T12:00:30Z');

export function clock(t = T0) {
  return {
    t,
    now() { return this.t; },
    advance(ms) { this.t += ms; return this.t; },
  };
}

export class FakeMarket {
  constructor(c) {
    this.clock = c;
    this.prices = { BTCUSDT: '65000', ETHUSDT: '2500', SOLUSDT: '150', BNBUSDT: '600', XRPUSDT: '0.6', DOGEUSDT: '0.12' };
    this.opens = {}; // `${symbol}@${openTime}` → price, else the current price
    this.down = false;
    this.calls = 0;
  }

  set(symbol, price) { this.prices[symbol] = price; }

  async latest(symbols) {
    this.calls++;
    if (this.down) throw new Error('market down');
    return Object.fromEntries(symbols.map((s) => [s, { price: this.prices[s], time: this.clock.now(), source: 'fake' }]));
  }

  async openAt(symbol, openTime) {
    this.calls++;
    if (this.down) throw new Error('market down');
    if (this.clock.now() < openTime) return null;
    return { price: this.opens[`${symbol}@${openTime}`] ?? this.prices[symbol], source: 'fake' };
  }

  async candles(symbol, interval, { limit = 1 } = {}) {
    this.calls++;
    if (this.down) throw new Error('market down');
    const p = this.prices[symbol];
    const step = 3600_000;
    const end = Math.floor(this.clock.now() / step) * step;
    return {
      source: 'fake',
      candles: Array.from({ length: limit }, (_, i) => ({ t: end - (limit - 1 - i) * step, o: p, h: p, l: p, c: p, v: '1' })),
    };
  }
}

export function setup({ config = {}, t = T0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'guard-'));
  saveConfig(root, { ...defaultConfig('test-agent'), ...config });
  const c = clock(t);
  const market = new FakeMarket(c);
  const guard = new Guard({ root, market, now: () => c.now() });
  return { root, c, market, guard, ledgerDir: join(root, 'ledger', 'test-agent') };
}

/** Move the clock past the next fill and run one call so fills settle. */
export async function settle(env) {
  env.c.advance(65_000);
  return env.guard.account();
}
