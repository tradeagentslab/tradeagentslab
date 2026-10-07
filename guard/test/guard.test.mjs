import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { loadOrCreateKey, publicRaw } from '../src/keys.js';
import { verifyLedger } from '../src/ledger.js';
import { normalizeSymbol } from '../src/guard.js';
import { DEFAULT_LIMITS } from '../src/rules.js';
import { settle, setup } from './helpers.mjs';

const events = (env) => readFileSync(join(env.ledgerDir, '2026-10-08.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const pub = (env) => publicRaw(loadOrCreateKey(join(env.root, 'keys', 'test-agent.key')));

test('a fresh account starts with 10,000 USDT and an init line', async () => {
  const env = setup();
  const a = await env.guard.account();
  assert.equal(a.equity_usdt, '10000');
  assert.equal(a.cash_usdt, '10000');
  assert.equal(a.halted, false);
  assert.deepEqual(a.positions, []);
  const [init] = events(env);
  assert.equal(init.type, 'init');
  assert.equal(init.data.start_cash, '10000.00000000');
  assert.equal(init.data.pubkey, pub(env));
});

test('buy → pending → fills at the next minute\'s open → ledger verifies', async () => {
  const env = setup();
  const r = await env.guard.placeOrder({ symbol: 'btc', side: 'buy', usdt: 650, reason: 'test entry' });
  assert.equal(r.status, 'accepted');
  assert.equal(r.fills_at, '2026-10-08T12:01:00.000Z');

  let a = await env.guard.account();
  assert.equal(a.pending_orders.length, 1);
  assert.equal(a.free_cash_usdt, '9349.35', '650 + 0.65 fee set aside');

  env.market.opens[`BTCUSDT@${Date.parse('2026-10-08T12:01:00Z')}`] = '65000';
  a = await settle(env);
  assert.equal(a.pending_orders.length, 0);
  assert.equal(a.positions[0].symbol, 'BTCUSDT');
  assert.equal(a.positions[0].qty, '0.01');
  assert.equal(a.cash_usdt, '9349.35');

  const f = await env.guard.fills();
  assert.equal(f.fills[0].price, '65000');
  assert.equal(f.fills[0].fee_usdt, '0.65');
  assert.deepEqual(verifyLedger(env.ledgerDir, pub(env)), { ok: true, count: events(env).length });
});

test('rejections are written down too, with the lock that stopped them', async () => {
  const env = setup();
  assert.equal((await env.guard.placeOrder({ symbol: 'PEPE', side: 'buy', usdt: 100, reason: 'x' })).rule, 'symbol');
  assert.equal((await env.guard.placeOrder({ symbol: 'BTC', side: 'buy', usdt: 1001, reason: 'x' })).rule, 'max_order');
  assert.equal((await env.guard.placeOrder({ symbol: 'BTC', side: 'buy', usdt: 100 })).rule, 'bad_input');
  assert.equal((await env.guard.placeOrder({ symbol: 'BTC', side: 'buy', usdt: 'lots', reason: 'x' })).rule, 'bad_input');
  assert.equal((await env.guard.placeOrder({ symbol: 'BTC', side: 'sell', qty: 1, reason: 'x' })).rule, 'no_position');
  const rejected = events(env).filter((e) => e.type === 'order' && e.data.verdict === 'rejected');
  assert.deepEqual(rejected.map((e) => e.data.rule), ['symbol', 'max_order', 'bad_input', 'bad_input', 'no_position']);
});

test('daily loss: after -5% today, buys stop and sells still go', async () => {
  const env = setup();
  await env.guard.account(); // writes today's start
  for (const sym of ['BTC', 'ETH', 'SOL']) {
    assert.equal((await env.guard.placeOrder({ symbol: sym, side: 'buy', usdt: 1000, reason: 'build position' })).status, 'accepted');
  }
  await settle(env);
  // 3,000 USDT in coins; a 20% drop costs 600 USDT = 6% of equity.
  env.market.set('BTCUSDT', '52000');
  env.market.set('ETHUSDT', '2000');
  env.market.set('SOLUSDT', '120');
  const a = await env.guard.account();
  assert.equal(a.today.buys_allowed, false);
  assert.equal((await env.guard.placeOrder({ symbol: 'BNB', side: 'buy', usdt: 100, reason: 'buy the dip' })).rule, 'daily_loss');
  assert.equal((await env.guard.placeOrder({ symbol: 'BTC', side: 'sell', qty: 'all', reason: 'cut losses' })).status, 'accepted');
});

test('max loss: equity at 70% of the start halts the guard by itself', async () => {
  const limits = { ...DEFAULT_LIMITS, max_order_pct: 100, max_symbol_pct: 100, daily_loss_pct: 100 };
  const env = setup({ config: { limits } });
  await env.guard.placeOrder({ symbol: 'BTC', side: 'buy', usdt: 9000, reason: 'all in, to test the breaker' });
  await settle(env);
  env.market.set('BTCUSDT', '40000');
  const a = await env.guard.account();
  assert.equal(a.halted.by, 'guard');
  assert.equal(a.halted.reason, 'max_loss');
  assert.equal((await env.guard.placeOrder({ symbol: 'BTC', side: 'sell', qty: 'all', reason: 'x' })).rule, 'halted');
});

test('agent halt cancels pending orders; only resume() lifts it', async () => {
  const env = setup();
  await env.guard.placeOrder({ symbol: 'ETH', side: 'buy', usdt: 100, reason: 'a' });
  const h = await env.guard.halt({ reason: 'data looks wrong' }, 'agent');
  assert.equal(h.halted.by, 'agent');
  const a = await env.guard.account();
  assert.equal(a.pending_orders.length, 0);
  assert.equal(a.free_cash_usdt, '10000');
  assert.equal((await env.guard.placeOrder({ symbol: 'ETH', side: 'buy', usdt: 100, reason: 'b' })).rule, 'halted');
  assert.equal((await env.guard.resume()).status, 'resumed');
  assert.equal((await env.guard.placeOrder({ symbol: 'ETH', side: 'buy', usdt: 100, reason: 'c' })).status, 'accepted');
});

test('human halt with flatten sells everything at the next open, even while halted', async () => {
  const env = setup();
  await env.guard.placeOrder({ symbol: 'ETH', side: 'buy', usdt: 500, reason: 'a' });
  await settle(env);
  const h = await env.guard.halt({ reason: 'stop now' }, 'human', { flatten: true });
  assert.equal(h.flatten_orders.length, 1);
  const a = await settle(env);
  assert.deepEqual(a.positions, []);
  assert.equal(a.halted.by, 'human');
});

test('a HALT file stops trading', async () => {
  const env = setup();
  writeFileSync(join(env.root, 'HALT'), '');
  const a = await env.guard.account();
  assert.equal(a.halted.reason, 'HALT file');
  await env.guard.resume();
  assert.equal((await env.guard.account()).halted, false);
});

test('editing config.json behind the guard\'s back halts it; resume records the new config', async () => {
  const env = setup();
  await env.guard.account();
  const file = join(env.root, 'config.json');
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  cfg.limits.max_order_pct = 100;
  writeFileSync(file, JSON.stringify(cfg));
  const a = await env.guard.account();
  assert.equal(a.halted.reason, 'config_changed');
  await env.guard.resume();
  const evs = events(env);
  assert.equal(evs.at(-2).type, 'config');
  assert.equal(evs.at(-2).data.limits.max_order_pct, '100');
  assert.equal(evs.at(-1).type, 'resume');
});

test('setConfig changes limits and leaves a config line; no halt', async () => {
  const env = setup();
  const r = await env.guard.setConfig({ max_order_pct: 5, symbols: 'btc,eth' });
  assert.deepEqual(r.symbols, ['BTCUSDT', 'ETHUSDT']);
  const a = await env.guard.account();
  assert.equal(a.halted, false);
  assert.equal(a.max_order_usdt_now, '500');
  assert.equal((await env.guard.placeOrder({ symbol: 'SOL', side: 'buy', usdt: 100, reason: 'x' })).rule, 'symbol');
});

test('30 rejected orders within an hour halts the guard (no loops)', async () => {
  const env = setup();
  for (let i = 0; i < 30; i++) await env.guard.placeOrder({ symbol: 'PEPE', side: 'buy', usdt: 100, reason: 'loop' });
  const a = await env.guard.account();
  assert.equal(a.halted.reason, 'rejection_loop');
});

test('12 accepted orders per hour, then the 13th is refused', async () => {
  const env = setup();
  for (let i = 0; i < 12; i++) {
    assert.equal((await env.guard.placeOrder({ symbol: 'DOGE', side: 'buy', usdt: 20, reason: `n${i}` })).status, 'accepted');
  }
  assert.equal((await env.guard.placeOrder({ symbol: 'DOGE', side: 'buy', usdt: 20, reason: 'n12' })).rule, 'rate_hour');
});

test('cancel one pending order or all', async () => {
  const env = setup();
  const a = await env.guard.placeOrder({ symbol: 'ETH', side: 'buy', usdt: 100, reason: 'a' });
  await env.guard.placeOrder({ symbol: 'SOL', side: 'buy', usdt: 100, reason: 'b' });
  assert.deepEqual((await env.guard.cancelOrder({ id: a.id })).ids, [a.id]);
  assert.equal((await env.guard.cancelOrder({ id: 'all' })).ids.length, 1);
  assert.equal((await env.guard.cancelOrder({ id: 'all' })).status, 'nothing_to_cancel');
});

test('state.json is only a cache: delete it and the ledger rebuilds the same account', async () => {
  const env = setup();
  await env.guard.placeOrder({ symbol: 'ETH', side: 'buy', usdt: 300, reason: 'a' });
  await settle(env);
  await env.guard.placeOrder({ symbol: 'ETH', side: 'sell', usdt: 100, reason: 'b' });
  const before = await env.guard.account();
  rmSync(join(env.root, 'state', 'test-agent.json'));
  const after = await env.guard.account();
  assert.deepEqual(after, before);
});

test('a new UTC day writes the day\'s start equity from the 00:00 open', async () => {
  const env = setup({ t: Date.parse('2026-10-08T23:58:30Z') });
  await env.guard.placeOrder({ symbol: 'BTC', side: 'buy', usdt: 650, reason: 'overnight' });
  env.c.advance(60_000); // 23:59:30 → fills at the 23:59 open
  await env.guard.account();
  env.market.opens[`BTCUSDT@${Date.parse('2026-10-09T00:00:00Z')}`] = '70000';
  env.c.advance(60_000); // 00:00:30 next day
  const a = await env.guard.account();
  assert.equal(a.today.start_equity_usdt, '10049.35', '9349.35 cash + 0.01 BTC × 70,000');
});

test('market down: the agent gets a clear error, nothing is written', async () => {
  const env = setup();
  await env.guard.account();
  const n = events(env).length;
  env.market.down = true;
  await assert.rejects(env.guard.placeOrder({ symbol: 'BTC', side: 'buy', usdt: 100, reason: 'x' }), /market data unavailable/);
  assert.equal(events(env).length, n);
});

test('symbols are cleaned up', () => {
  assert.equal(normalizeSymbol('btc'), 'BTCUSDT');
  assert.equal(normalizeSymbol('BTC/USDT'), 'BTCUSDT');
  assert.equal(normalizeSymbol('ethusdt'), 'ETHUSDT');
});
