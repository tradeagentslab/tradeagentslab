// The Binance gate on the server: 12 requests per rolling 60 s (catch-up included),
// the shared pause directory, 429 back-off, 418/403 stop, user agent, one log line
// per request, and never any exchange but Binance. All offline: fake clock, fake Binance.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { BannedError, createBinanceGate, GateClosedError, readPauses, retryAfterSec } from '../engine/binance-gate.js';
import { loadEngineConfig, USER_AGENT } from '../engine/main.js';
import { T0, world } from './world.mjs';

const MIN = 60_000;
const VERSION = JSON.parse(readFileSync(new URL('../../guard/package.json', import.meta.url), 'utf8')).version;
const sec = (ms) => Math.floor(ms / 1000);

/** Most requests in any 60 s window. */
function peak(times) {
  let best = 0;
  for (let i = 0; i < times.length; i++) {
    let n = 0;
    for (let j = i; j < times.length && times[j] < times[i] + MIN; j++) n++;
    best = Math.max(best, n);
  }
  return best;
}

/** Rounds every 20 s for `ms`, like the service. */
async function rounds(w, ms) {
  const end = w.clock.t + ms;
  while (w.clock.t < end) {
    await w.loop.once();
    w.clock.t += 20_000;
  }
}

test('catch-up after three days down trickles at ≤ 12 per 60 s; steady state is 6 a minute', async () => {
  const w = world();
  w.clock.t = T0 + 3 * 24 * 60 * MIN + 30_000; // engine first starts three days into the season
  await rounds(w, 25 * MIN);
  const target = Math.floor((w.clock.t - 20_000) / MIN) * MIN - 2 * MIN;
  assert.ok(w.loop.arena.minute >= target, 'caught up');
  assert.ok(w.loop.s.snapshot, 'snapshot published');
  const times = w.binance.asked.map((r) => r.t);
  assert.equal(peak(times), 12, 'catch-up uses the budget and never more');
  assert.ok(times.length > 12 * 3, 'more than one window of requests was needed');

  // steady state: ten minutes, one 1-minute request per symbol per minute, nothing else
  const from = w.binance.asked.length;
  const start = w.clock.t;
  await rounds(w, 10 * MIN);
  const steady = w.binance.asked.slice(from);
  assert.equal(steady.length, 60, `${steady.length} requests in 10 minutes`);
  assert.ok(steady.every((r) => /interval=1m/.test(r.url)), 'snapshot comes from the same 1-minute candles');
  for (let m = start; m < start + 10 * MIN; m += MIN) {
    assert.ok(steady.filter((r) => r.t >= m && r.t < m + MIN).length <= 6);
  }
  assert.ok(peak(steady.map((r) => r.t)) <= 6);
  // the snapshot keeps moving with the minutes
  const snap = w.loop.s.snapshot;
  assert.equal(snap.markets.BTCUSDT.candles1h.length, 24);
  assert.equal(snap.asOf, new Date(w.clock.t - 20_000).toISOString());
});

test('the daily candle for the moving-average baseline still comes at 00:00, inside the budget', async () => {
  const w = world({ roster: [], baselines: ['baseline-ma'] });
  w.clock.t = T0 + 23 * 60 * MIN + 50 * MIN;
  await w.catchUp();
  const from = w.binance.asked.length;
  await rounds(w, 20 * MIN); // across midnight
  const asked = w.binance.asked.slice(from);
  assert.equal(asked.filter((r) => /interval=1d/.test(r.url)).length, 1);
  assert.ok(peak(asked.map((r) => r.t)) <= 7);
});

test('pause files: every *.pause is read; malformed or past ones do not pause; feed2.pause blocks', async () => {
  const w = world();
  const t = T0 + 2 * 60 * MIN;
  writeFileSync(join(w.pauseDir, 'old.pause'), `${sec(t) - 10}\n429 data-api\n`);
  writeFileSync(join(w.pauseDir, 'junk.pause'), 'tomorrow\n');
  writeFileSync(join(w.pauseDir, 'empty.pause'), '');
  writeFileSync(join(w.pauseDir, 'notes.txt'), `${sec(t) + 9999}\n`); // not a .pause file
  assert.equal(readPauses(w.pauseDir, t), null);
  assert.equal(readPauses(join(w.pauseDir, 'missing'), t), null, 'no directory: not paused');

  writeFileSync(join(w.pauseDir, 'feed2.pause'), `${sec(t) + 600}\n403 data-api\n`);
  writeFileSync(join(w.pauseDir, 'other.pause'), `${sec(t) + 300}\n`);
  assert.deepEqual(readPauses(w.pauseDir, t), { file: 'feed2.pause', until: (sec(t) + 600) * 1000, reason: '403 data-api' });

  w.clock.t = t;
  await rounds(w, 9 * MIN); // the engine waits, it does not exit
  assert.equal(w.binance.asked.length, 0, 'no Binance request while paused');
  assert.ok(w.logs.some((l) => /paused by feed2\.pause/.test(l)));
  assert.equal(w.logs.filter((l) => /paused by feed2\.pause/.test(l)).length, 1, 'said once, not every round');

  w.clock.t = t + 601_000;
  await w.loop.once();
  assert.ok(w.binance.asked.length > 0, 'asks again once the pause is over');
  assert.ok(!existsSync(join(w.pauseDir, 'arena.pause')), 'the engine never writes for someone else\'s pause');
});

test('429: nothing written, waits for Retry-After, then carries on within budget', async () => {
  const w = world();
  w.clock.t = T0 + 10 * MIN + 30_000;
  w.binance.next.push({ status: 429, headers: { 'retry-after': '120' } });
  await w.loop.once(); // does not throw: the round still pushes to the front door
  assert.equal(w.binance.asked.length, 1);
  assert.deepEqual(readdirSync(w.pauseDir), [], 'a 429 writes no pause file');
  w.clock.t += 100_000;
  await w.loop.once();
  assert.equal(w.binance.asked.length, 1, 'still waiting');
  w.clock.t += 21_000;
  await w.loop.once();
  assert.ok(w.binance.asked.length > 1, 'back after Retry-After');
});

test('429 without Retry-After backs off 60 s, then 120 s', async () => {
  let t = 0;
  const replies = [429, 429, 200];
  const gate = createBinanceGate({
    fetchImpl: async () => new Response('[]', { status: replies.shift() }), now: () => t,
    userAgent: USER_AGENT, pauseDir: '/nonexistent', out: () => {}, log: () => {},
  });
  await assert.rejects(gate.fetch('https://data-api.binance.vision/api/v3/klines?x=1'), (e) => e instanceof GateClosedError && e.until === 60_000);
  t = 59_000;
  await assert.rejects(gate.fetch('https://data-api.binance.vision/api/v3/klines?x=1'), /backing off/);
  t = 60_000;
  await assert.rejects(gate.fetch('https://data-api.binance.vision/api/v3/klines?x=1'), (e) => e.until === 180_000);
  t = 180_000;
  assert.equal((await gate.fetch('https://data-api.binance.vision/api/v3/klines?x=1')).status, 200);
});

for (const [status, retryAfter, wait] of [[418, '3600', 3600], [418, null, 7200], [403, null, 7200]]) {
  test(`${status}${retryAfter ? ' with Retry-After' : ''}: arena.pause written (+${wait} s), engine stops and exits`, async () => {
    const w = world();
    w.clock.t = T0 + 10 * MIN + 30_000;
    w.binance.next.push({ status, headers: retryAfter ? { 'retry-after': retryAfter } : {} });
    await assert.rejects(w.loop.once(), (e) => e instanceof BannedError);
    assert.deepEqual(readdirSync(w.pauseDir), ['arena.pause'], 'written by rename: no temp file left');
    assert.equal(readFileSync(join(w.pauseDir, 'arena.pause'), 'utf8'), `${Math.ceil(w.clock.t / 1000) + wait}\n${status} data-api\n`);
    // no more requests, ever, from this process
    await assert.rejects(w.loop.once(), BannedError);
    assert.equal(w.binance.asked.length, 1);
    // run() logs it and gives up instead of looping (main.js then exits non-zero)
    await assert.rejects(w.loop.run(), BannedError);
    assert.ok(w.logs.some((l) => l.startsWith('STOPPED: Binance answered')));
    // a restarted engine sees its own pause and waits
    w.clock.t += 60_000;
    const gate = createBinanceGate({ fetchImpl: w.fetchImpl, now: () => w.clock.t, userAgent: USER_AGENT, pauseDir: w.pauseDir, out: () => {}, log: () => {} });
    assert.equal(gate.available(), 0);
  });
}

test('only Binance public data is ever asked; an OKX price source is refused', async () => {
  const w = world();
  w.clock.t = T0 + 3 * 60 * MIN;
  w.binance.next.push({ status: 503 }); // Binance down: the round fails, no fallback anywhere
  await assert.rejects(w.loop.once(), /no market data for BTCUSDT: HTTP 503 from data-api\.binance\.vision/);
  w.clock.t += 20_000;
  await rounds(w, 5 * MIN);
  const hosts = new Set(w.http.map((l) => l.split(' ')[2]));
  assert.deepEqual([...hosts].sort(), ['arena.test', 'data-api.binance.vision']);
  const dir = w.home;
  writeFileSync(join(dir, 'okx.json'), JSON.stringify({ api: 'x', home: dir, roster: 'r', season: { id: 'S1', from: '2026-10-28T00:00:00Z', to: '2026-12-01T00:00:00Z' }, priceSource: 'okx' }));
  assert.throws(() => loadEngineConfig(join(dir, 'okx.json')), /only be "binance"/);
});

test('user agent tal-arena/<version> on every request; one greppable log line each', async () => {
  const w = world();
  w.clock.t = T0 + 30 * MIN;
  await w.catchUp();
  assert.equal(USER_AGENT, `tal-arena/${VERSION}`);
  assert.ok(w.binance.asked.every((r) => r.headers['user-agent'] === USER_AGENT));
  const apiLines = w.http.filter((l) => / arena\.test /.test(l));
  const bnLines = w.http.filter((l) => / data-api\.binance\.vision /.test(l));
  assert.equal(bnLines.length, w.binance.asked.length, 'one line per Binance request');
  assert.ok(apiLines.length >= 2, 'front-door requests are logged too');
  for (const l of w.http) {
    assert.match(l, /^http \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \S+ \/\S* (\d{3}|error:\w+) \d+ms$/);
    assert.ok(!l.includes('?'), 'no query strings');
  }
  assert.ok(bnLines.every((l) => / \/api\/v3\/klines 200 /.test(l)));
});

test('Retry-After: seconds or an HTTP date', () => {
  assert.equal(retryAfterSec('120', 0), 120);
  assert.equal(retryAfterSec(new Date(90_000).toUTCString(), 0), 90);
  assert.equal(retryAfterSec('soon', 0), null);
  assert.equal(retryAfterSec(null, 0), null);
});
