// The candle store used by `tal arena recompute`. No network: a fake Binance.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createKlines, MissingCandlesError, parseBinanceCsv } from '../src/arena/klines.js';

const MINUTE = 60_000;
const DAY = 86_400_000;
const D0 = Date.parse('2026-11-02T00:00:00Z');

function fakeBinance(clock, script = []) {
  const asked = [];
  const f = async (url) => {
    const u = new URL(url);
    asked.push({ t: clock.t, url });
    const next = script.shift();
    if (next) return new Response('{}', { status: next.status, headers: next.headers ?? {} });
    const start = Number(u.searchParams.get('startTime'));
    const limit = Number(u.searchParams.get('limit'));
    const step = u.searchParams.get('interval') === '1d' ? DAY : MINUTE;
    const rows = [];
    for (let t = start; rows.length < limit && t <= clock.t; t += step) rows.push([t, '1.0', '1.0', '1.0', '1.1', '5', t + step - 1]);
    return new Response(JSON.stringify(rows));
  };
  f.asked = asked;
  return f;
}

const setup = (script, t = D0 + 3 * DAY) => {
  const clock = { t };
  const fetchImpl = fakeBinance(clock, script);
  const dir = mkdtempSync(join(tmpdir(), 'klines-'));
  const k = createKlines({ dir, fetchImpl, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } });
  return { clock, fetchImpl, dir, k };
};

test('two whole days: 3 requests of at most 1,000 candles, saved, then read from disk', async () => {
  const { k, fetchImpl, dir } = setup();
  const m = await k.range('BTCUSDT', '1m', D0, D0 + 2 * DAY);
  assert.equal(m.size, 2880);
  assert.equal(fetchImpl.asked.length, 3);
  assert.ok(fetchImpl.asked.every((a) => new URL(a.url).host === 'data-api.binance.vision'));
  assert.ok(existsSync(join(dir, 'BTCUSDT', '1m', '2026-11-02.json')));
  const again = await k.range('BTCUSDT', '1m', D0 + 60 * MINUTE, D0 + 120 * MINUTE);
  assert.equal(again.size, 60);
  assert.equal(fetchImpl.asked.length, 3, 'no new request');
});

test('never more than 12 requests in any 60 s', async () => {
  const { k, fetchImpl } = setup([], D0 + 12 * DAY);
  for (const s of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) await k.range(s, '1m', D0, D0 + 10 * DAY); // 15 requests each
  assert.equal(fetchImpl.asked.length, 45);
  for (const a of fetchImpl.asked) assert.ok(fetchImpl.asked.filter((b) => b.t > a.t - 60_000 && b.t <= a.t).length <= 12);
});

test('429: waits Retry-After, then carries on', async () => {
  const { k, fetchImpl } = setup([{ status: 429, headers: { 'retry-after': '7' } }]);
  await k.range('ETHUSDT', '1m', D0, D0 + 100 * MINUTE);
  assert.equal(fetchImpl.asked.length, 3, 'the 429, then the whole day in two requests (so it can be saved)');
  assert.ok(fetchImpl.asked[1].t - fetchImpl.asked[0].t >= 7000);
});

test('418: stops at once and leaves a pause file', async () => {
  const { k, dir } = setup([{ status: 418, headers: { 'retry-after': '120' } }]);
  await assert.rejects(k.range('ETHUSDT', '1m', D0, D0 + DAY), (err) => err.banned === true);
  assert.ok(existsSync(join(dir, '.pause', 'arena.pause')));
});

test('a day that is not over yet is used but not saved', async () => {
  const { k, dir } = setup([], D0 + 5 * 60 * MINUTE);
  const m = await k.range('BTCUSDT', '1m', D0, D0 + 3 * 60 * MINUTE);
  assert.equal(m.size, 180);
  assert.ok(!existsSync(join(dir, 'BTCUSDT', '1m', '2026-11-02.json')));
});

test('offline: never asks, reads Binance CSV files, names what is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'klines-off-'));
  let calls = 0;
  const k = createKlines({ dir, offline: true, fetchImpl: async () => { calls += 1; } });
  const us = (t) => String(t * 1000); // Binance spot files from 2025 on use microseconds
  writeFileSync(join(dir, 'BTCUSDT-1m-2026-11-02.csv'), `${us(D0)},1.0,1.2,0.9,1.1,5,0,0,0,0,0,0\n${us(D0 + MINUTE)},1.1,1.2,1.0,1.2,5,0,0,0,0,0,0\n`);
  const m = await k.range('BTCUSDT', '1m', D0, D0 + 2 * MINUTE);
  assert.deepEqual(m.get(D0 + MINUTE), [D0 + MINUTE, '1.1', '1.2', '1.0', '1.2', '5']);
  await assert.rejects(k.range('ETHUSDT', '1m', D0, D0 + DAY), (err) => err instanceof MissingCandlesError && /ETHUSDT 1m 2026-11-02/.test(err.message));
  assert.equal(calls, 0);
  assert.equal(parseBinanceCsv('open_time,open\n').length, 0, 'a header line is skipped');
});
