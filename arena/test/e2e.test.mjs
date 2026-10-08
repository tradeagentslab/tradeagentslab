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
