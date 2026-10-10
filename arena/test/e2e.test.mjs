// The whole chain, offline: an agent signs an order → the front door (Worker on a
// fake D1) stores it → the engine pulls it, fills it on fake candles, signs its
// results and pushes them back → anyone can read the board and check signatures.

import assert from 'node:assert/strict';
import test from 'node:test';

import { canon } from '../../guard/src/canon.js';
import { verifyText } from '../../guard/src/keys.js';
import { GENESIS } from '../../guard/src/ledger.js';
import { EngineLoop } from '../engine/main.js';
import { makeOrder } from '../src/orders.js';
import { validateStandings } from '../src/standings.js';
import { API, T0, world } from './world.mjs';

test('order in, fill out, board up, every engine line verifiable', async () => {
  const w = world();
  const r1 = await w.loop.once();
  assert.deepEqual(r1.added, ['tal-claude']);
  assert.ok(w.logs.some((l) => /bad-name not added/.test(l)), 'names with banned words never reach the board');
  assert.equal((await w.get('/agents.json')).agents.length, 1);

  w.clock.t = T0 + 30_000;
  const o = makeOrder({ key: w.agentKey, agent: 'tal-claude', now: w.clock.t, symbol: 'ETHUSDT', side: 'buy', usdt: 500, reason: 'first trade', state: { seq: -1, hash: GENESIS } });
  const posted = await w.fetchImpl(`${API}/orders`, { method: 'POST', body: o.line });
  assert.equal(posted.status, 201);

  w.clock.t = T0 + 2 * 60_000 + 25_000;
  await w.loop.once();

  const acct = await w.get('/accounts/tal-claude.json');
  assert.equal(acct.positions[0].symbol, 'ETHUSDT');
  assert.equal(acct.positions[0].price, '2502.50000000', 'marked at the 00:01 close');
  assert.equal(acct.positions[0].qty, '0.19980019');

  const board = await w.get('/standings/latest.json');
  assert.deepEqual(validateStandings(board), []);
  assert.equal(board.rows[0].trades, 1);
  assert.equal(board.source, 'test arena');
  assert.equal(board.sample, false);

  const led = await w.get('/ledger/tal-claude/2026-10-28.json');
  assert.equal(led.orders[0].line, o.line);
  const fill = led.results.map((l) => JSON.parse(l)).find((e) => e.type === 'fill');
  assert.equal(fill.data.price, '2502.50000000', 'filled at the open of 00:01, the minute after it arrived');
  assert.equal(fill.data.source, 'binance');
  for (const line of led.results) {
    const { sig, ...body } = JSON.parse(line);
    assert.equal(canon(JSON.parse(line)), line, 'lines are canonical');
    assert.equal(verifyText(w.loop.pubkey(), canon(body), sig), true, 'engine signature checks out');
  }
});

test('a lost reply does not jam the loop: the next round goes through', async () => {
  const w = world();
  await w.loop.once();
  w.clock.t = T0 + 2 * 60_000 + 25_000;
  w.loseNextReply();
  await assert.rejects(w.loop.once(), /reply lost/);
  w.clock.t += 20_000;
  await w.loop.once();
  const health = await w.get('/health');
  assert.ok(health.engine_seen);
});

test('the engine restarts from its saved state and carries on', async () => {
  const w = world();
  await w.loop.once();
  w.clock.t = T0 + 5 * 60_000;
  await w.loop.once();
  const before = w.loop.arena.minute;
  const again = new EngineLoop({ config: w.loop.c, fetchImpl: w.fetchImpl, now: () => w.clock.t, log: () => {}, out: () => {} });
  assert.equal(again.arena.minute, before);
  assert.equal(again.pubkey(), w.loop.pubkey());
  w.clock.t += 3 * 60_000;
  await again.once();
  assert.equal(again.arena.minute, before + 3 * 60_000);
});

test('settled_to on /health: null before the season, follows the engine in season, null once the season closed', async () => {
  const w = world({ season: { id: 'S1', from: T0 + 10 * 60_000, to: T0 + 20 * 60_000 } });
  w.clock.t = T0;
  await w.loop.once();
  assert.equal((await w.get('/health')).settled_to, null, 'season not started');
  w.clock.t = T0 + 15 * 60_000 + 25_000;
  await w.catchUp();
  // Settled every minute before 15:00 minus one (the newest finished minute waits 20 s)
  assert.equal(w.loop.arena.minute, T0 + 14 * 60_000);
  assert.equal((await w.get('/health')).settled_to, new Date(T0 + 15 * 60_000).toISOString());
  assert.equal((await w.get('/standings/latest.json')).asOf, (await w.get('/health')).settled_to, 'same as the live board');
  w.clock.t = T0 + 21 * 60_000 + 25_000;
  await w.catchUp();
  assert.equal(w.loop.arena.seasonClosed, true);
  assert.equal((await w.get('/health')).settled_to, null, 'season over');
});

test('a missing candle: settled_to stops at that minute while engine_seen stays fresh; one log line after 5 min, then every 30 min', async () => {
  const w = world();
  w.clock.t = T0 + 3 * 60_000 + 25_000;
  await w.catchUp();
  const gap = w.loop.arena.minute + 60_000; // the next minute to settle
  assert.equal((await w.get('/health')).settled_to, new Date(gap).toISOString());
  const candles = w.loop.market.candles;
  w.loop.market.candles = async (s, interval, opts) => {
    const r = await candles(s, interval, opts);
    return s === 'SOLUSDT' && interval === '1m' ? { ...r, candles: r.candles.filter((k) => k.t !== gap) } : r;
  };
  const stuck = () => w.logs.filter((l) => l.startsWith('settling stuck'));
  const start = w.clock.t;
  // Rounds every 20 s for 40 minutes
  while (w.clock.t < start + 40 * 60_000) {
    w.clock.t += 20_000;
    await w.loop.once();
    const h = await w.get('/health');
    assert.equal(h.settled_to, new Date(gap).toISOString());
    assert.equal(h.engine_seen, new Date(w.clock.t).toISOString());
    if (w.clock.t - start <= 5 * 60_000) assert.equal(stuck().length, 0, 'not within the first 5 minutes');
  }
  assert.equal(stuck().length, 2, 'after 5 min, and again 30 min later');
  const at = new Date(gap).toISOString();
  assert.equal(stuck()[0], `settling stuck at ${at} for 5 min: no 1-minute candle from Binance for SOLUSDT`);
  assert.ok(stuck()[1].startsWith(`settling stuck at ${at} for 35 min: `), stuck()[1]);
  assert.ok(!w.logs.some((l) => l.startsWith('http ')), 'the http log lines go to the other stream, untouched');
  // The candle turns up: settling moves on, no more lines
  w.loop.market.candles = candles;
  for (let i = 0; i < 6; i++) {
    w.clock.t += 20_000;
    await w.loop.once();
  }
  assert.ok(Date.parse((await w.get('/health')).settled_to) > gap);
  assert.equal(stuck().length, 2);
});
