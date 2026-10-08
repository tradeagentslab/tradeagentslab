// Arena mode against a whole arena running in this process (front door on a fake
// database, engine on made-up candles). No network.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { API, T0, world } from '../../arena/test/world.mjs';
import { ArenaGuard } from '../src/arena-guard.js';
import { defaultConfig, saveConfig } from '../src/config.js';
import { FakeMarket } from './helpers.mjs';

async function setup({ register = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'guard-arena-'));
  saveConfig(root, { ...defaultConfig('my-bot'), venue: 'arena', arena_url: API });
  const clock = { t: T0 + 6 * 3600_000 + 5_000 };
  const probe = new ArenaGuard({ root, market: new FakeMarket(clock), now: () => clock.t });
  const entry = await probe.signup({ name: 'My Bot', model: 'Some Model 1' });
  const w = world({ roster: register ? [{ ...entry, joined: '2026-10-28T00:00:00Z' }] : [] });
  w.clock.t = clock.t;
  await w.catchUp(); // six hours of candles, fetched within the engine's Binance budget
  const guard = new ArenaGuard({ root, market: new FakeMarket(w.clock), now: () => w.clock.t, fetchImpl: w.fetchImpl });
  return { w, guard, root };
}

const orderCount = async (w) => (await (await w.fetchImpl(`${API}/orders?after=0`)).json()).orders.length;

test('sign up, send a signed order, the arena fills it, fills and account show it', async () => {
  const { w, guard } = await setup();
  const r = await guard.placeOrder({ symbol: 'eth', side: 'buy', usdt: 300, reason: 'first arena order' });
  assert.equal(r.status, 'sent');
  assert.equal(await orderCount(w), 1);
  w.clock.t += 2 * 60_000 + 25_000;
  await w.loop.once();
  const f = await guard.fills();
  assert.equal(f.fills[0].type, 'fill');
  assert.equal(f.fills[0].symbol, 'ETHUSDT');
  const a = await guard.account();
  assert.equal(a.venue, 'arena');
  assert.equal(a.positions[0].symbol, 'ETHUSDT');
});

test('obvious mistakes never leave this machine', async () => {
  const { w, guard } = await setup();
  assert.equal((await guard.placeOrder({ symbol: 'BTC', side: 'buy', usdt: 5000, reason: 'too big' })).rule, 'max_order');
  assert.equal((await guard.placeOrder({ symbol: 'PEPE', side: 'buy', usdt: 100, reason: 'not listed' })).rule, 'symbol');
  assert.equal((await guard.placeOrder({ symbol: 'BTC', side: 'buy', usdt: 100 })).rule, 'bad_input');
  assert.equal(await orderCount(w), 0);
});

test('halting here stops sending; only a person resumes', async () => {
  const { w, guard } = await setup();
  const h = await guard.halt({ reason: 'looks wrong' }, 'agent');
  assert.match(h.note, /stops sending/);
  assert.equal((await guard.placeOrder({ symbol: 'ETH', side: 'buy', usdt: 100, reason: 'x' })).rule, 'halted');
  await guard.resume();
  assert.equal((await guard.placeOrder({ symbol: 'ETH', side: 'buy', usdt: 100, reason: 'x' })).status, 'sent');
  assert.equal(await orderCount(w), 1);
});

test('not signed up yet: a clear message, nothing sent', async () => {
  const { w, guard } = await setup({ register: false });
  await assert.rejects(guard.account(), /not in the arena yet/);
  await assert.rejects(guard.placeOrder({ symbol: 'ETH', side: 'buy', usdt: 100, reason: 'x' }), /not in the arena yet/);
  assert.equal(await orderCount(w), 0);
});

test('limits cannot be changed in arena mode; cancel is not available', async () => {
  const { guard } = await setup();
  await assert.rejects(guard.setConfig({ max_order_pct: 50 }), /season rules/);
  assert.equal((await guard.cancelOrder({ id: 'all' })).status, 'not_available');
});
