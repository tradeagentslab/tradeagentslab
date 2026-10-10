// The S0 rehearsal script (rehearsal/run.mjs) on made-up candles, no network: the
// whole chain (candle cache → engine + front door + agents through the guard → boards
// → arena-data snapshot → `tal arena recompute`) must pass, the candle download must
// stay inside the Binance budget, and a missing candle must stop engine and recompute
// at the same minute with a clear message.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { cli, defaultFrom, formatRehearsal, liveCut, rehearse, snapshotPath } from '../rehearsal/run.mjs';

// The copies are made by the arena-data repository's own script: side by side here,
// checked out into .arena-data on GitHub (see .github/workflows/check.yml).
const noArenaData = snapshotPath().found ? false : "arena-data's scripts/snapshot.mjs not found (check out tradeagentslab/arena-data into .arena-data)";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FROM = Date.parse('2026-11-01T00:00:00Z'); // a Sunday: week 2026-W44 is one day, then 2026-W45
const DAYS = 2;
const TO = FROM + DAYS * DAY;
const NOW = TO + 10 * DAY;
const BASE = { BTCUSDT: 65000, ETHUSDT: 2500, SOLUSDT: 150, BNBUSDT: 600, XRPUSDT: 0.6, DOGEUSDT: 0.12 };
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** A repeatable random walk with real-looking moves (a few % a day), as Binance-style rows. */
function synthetic(symbol, from, to, step) {
  let seed = [...symbol].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
  const rnd = () => {
    seed = (seed * 1_103_515_245 + 12_345) >>> 0;
    return seed / 2 ** 32;
  };
  const dp = BASE[symbol] < 1 ? 6 : 2;
  let p = BASE[symbol];
  const rows = [];
  // Start the walk well before `from`, so every window sees the same prices at the same minute.
  for (let t = from - ((from / step) % 4000) * step; t < to; t += step) {
    const drift = Math.sin(t / (9 * HOUR)) * 0.0009 * Math.sqrt(step / MINUTE);
    const o = p;
    p *= 1 + drift + (rnd() - 0.5) * 0.0016 * Math.sqrt(step / MINUTE);
    if (t < from) continue;
    const hi = Math.max(o, p) * (1 + rnd() * 0.0005);
    const lo = Math.min(o, p) * (1 - rnd() * 0.0005);
    rows.push([t, o.toFixed(dp), hi.toFixed(dp), lo.toFixed(dp), p.toFixed(dp), (rnd() * 10).toFixed(4)]);
  }
  return rows;
}

/** A cache in klines.js's layout: the warm-up day and the season (1m), BTC daily from 20 days before. */
function writeCache(dir, { gap } = {}) {
  for (const s of Object.keys(BASE)) {
    mkdirSync(join(dir, s, '1m'), { recursive: true });
    const rows = synthetic(s, FROM - DAY, TO, MINUTE).filter((r) => !(gap && gap.symbol === s && r[0] >= gap.from && r[0] < gap.to));
    for (let d = FROM - DAY; d < TO; d += DAY) {
      writeFileSync(join(dir, s, '1m', `${day(d)}.json`), JSON.stringify(rows.filter((r) => r[0] >= d && r[0] < d + DAY)));
    }
  }
  mkdirSync(join(dir, 'BTCUSDT', '1d'), { recursive: true });
  for (const r of synthetic('BTCUSDT', FROM - 20 * DAY, TO, DAY)) writeFileSync(join(dir, 'BTCUSDT', '1d', `${day(r[0])}.json`), JSON.stringify([r]));
}

test('the window: newest whole Wednesday-start window before today; the live cut after the first Monday', () => {
  assert.equal(new Date(defaultFrom(Date.parse('2026-10-10T09:00:00Z'))).toISOString(), '2026-09-30T00:00:00.000Z');
  assert.equal(new Date(defaultFrom(Date.parse('2026-10-28T00:30:00Z'))).toISOString(), '2026-10-21T00:00:00.000Z', 'S0 itself, the day after it ends');
  const s0 = Date.parse('2026-10-21T00:00:00Z');
  assert.equal(new Date(liveCut(s0, s0 + 6 * DAY)).toISOString(), '2026-10-26T06:00:00.000Z');
  assert.equal(new Date(liveCut(FROM, TO)).toISOString(), '2026-11-02T06:00:00.000Z');
});

test('a clean mini season on cached candles: boards out, every recompute matches', { skip: noArenaData }, async () => {
  const cache = mkdtempSync(join(tmpdir(), 'rehearsal-cache-'));
  writeCache(cache);
  const t0 = performance.now();
  const rep = await rehearse({ from: FROM, days: DAYS, cache, offline: true, step: 60, now: () => NOW });
  const secs = (performance.now() - t0) / 1000;
  const text = formatRehearsal(rep).join('\n');
  assert.equal(rep.ok, true, text);
  assert.deepEqual(rep.candles.anomalies, []);
  assert.equal(rep.fetch.requests, 0, 'offline: nothing asked');
  assert.deepEqual(rep.boards.weekly.map((w) => w.id), ['2026-W44', '2026-W45']);
  assert.equal(rep.boards.season.rows.length, 5, 'three baselines and two agents');
  assert.equal(rep.boards.live.asOf, '2026-11-02T06:00:00.000Z');
  assert.deepEqual(rep.recompute.map((c) => [c.label, c.code, c.ok]), [
    ['week 2026-W44', 0, true], ['week 2026-W45', 0, true], ['season S0', 0, true], ['live 2026-W45 as of 2026-11-02T06:00:00.000Z', 0, true],
  ]);
  assert.ok(rep.engine.peakPerMinute <= 12, 'the engine kept to its Binance budget');
  const burst = rep.agents['rehearsal-burst'];
  assert.ok(burst.refusedAtFill.rate_hour >= 2, 'the 13th and 14th order of the hour are refused at fill');
  assert.ok(burst.localRefused.no_position || burst.localRefused.bad_input, 'selling a coin it does not hold never leaves the machine');
  assert.ok(burst.sells >= 1);
  const trend = rep.agents['rehearsal-trend'];
  assert.ok(trend.localRefused.max_order >= 1, 'the too-big order is refused on the machine');
  assert.ok(trend.buys >= 1);
  assert.ok(rep.agents['baseline-hold'].buys >= 3);
  assert.match(text, /REHEARSAL PASSED/);
  assert.match(text, /week 2026-W44 .* exit 0 · Everything matches/);
  process.stderr.write(`# rehearsal: ${DAYS} synthetic days, ${rep.rounds} rounds of 60 s, ${secs.toFixed(1)} s (season ${rep.timing.seasonSec.toFixed(1)} s, recompute ${rep.timing.recomputeSec.toFixed(1)} s)\n`);
});

test('a missing candle: engine and recompute both stop at that minute, the rehearsal fails and says why', { skip: noArenaData }, async () => {
  const cache = mkdtempSync(join(tmpdir(), 'rehearsal-gap-'));
  const gapAt = FROM + 30 * HOUR + 7 * MINUTE;
  writeCache(cache, { gap: { symbol: 'SOLUSDT', from: gapAt, to: gapAt + 2 * MINUTE } });
  const rep = await rehearse({ from: FROM, days: DAYS, cache, offline: true, step: 300, now: () => NOW });
  assert.equal(rep.ok, false);
  assert.deepEqual(rep.candles.anomalies, ['SOLUSDT: no 1-minute candle 2026-11-02 06:07–2026-11-02 06:09 UTC (2 min)']);
  assert.equal(rep.engine.stall.at, new Date(gapAt).toISOString());
  assert.deepEqual(rep.engine.stall.symbols, ['SOLUSDT']);
  assert.equal(rep.boards.season, null);
  assert.ok(rep.problems.some((p) => /engine stopped at 2026-11-02T06:07:00.000Z: no 1-minute candle for SOLUSDT/.test(p)));
  // The live copy at 06:00 is before the gap, and the closed first week too: both still recompute.
  assert.ok(rep.recompute.find((c) => c.label === 'week 2026-W44').ok);
  assert.ok(rep.recompute.find((c) => c.label.startsWith('live')).ok);
  assert.match(formatRehearsal(rep).join('\n'), /STOPPED at 2026-11-02T06:07:00.000Z: no candle for SOLUSDT/);
});

test('download through the gate: ≤ 12 requests in any 60 s, then all from the cache', async () => {
  const cache = mkdtempSync(join(tmpdir(), 'rehearsal-dl-'));
  const clock = { t: NOW };
  const asked = [];
  const rows = Object.fromEntries(Object.keys(BASE).map((s) => [s, synthetic(s, FROM - DAY, TO, MINUTE)]));
  const daily = synthetic('BTCUSDT', FROM - 20 * DAY, TO, DAY);
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    asked.push({ t: clock.t, host: u.host, ua: init?.headers?.['user-agent'] });
    const q = u.searchParams;
    const src = q.get('interval') === '1d' ? daily : rows[q.get('symbol')];
    const start = Number(q.get('startTime'));
    const out = src.filter((r) => r[0] >= start).slice(0, Number(q.get('limit'))).map((r) => [...r, r[0] + 59_999]);
    return new Response(JSON.stringify(out));
  };
  const deps = { fetchImpl, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } };
  const rep = await rehearse({ from: FROM, days: DAYS, cache, fetchOnly: true, ...deps });
  assert.equal(rep.ok, true);
  // 3 days × 1,440 minutes = 5 requests of ≤ 1,000 per symbol, plus 1 for the daily closes.
  assert.equal(asked.length, 6 * 5 + 1);
  assert.ok(asked.every((a) => a.host === 'data-api.binance.vision' && /^tal-rehearsal\//.test(a.ua)));
  for (const a of asked) assert.ok(asked.filter((b) => b.t > a.t - 60_000 && b.t <= a.t).length <= 12);
  assert.ok(rep.fetch.peakPerMinute <= 12);
  assert.deepEqual(rep.candles.anomalies, []);
  const again = await rehearse({ from: FROM, days: DAYS, cache, fetchOnly: true, ...deps });
  assert.equal(again.fetch.requests, 0, 'second time: all from the cache');
  assert.equal(asked.length, 31);
});

test('blocked from Binance: 451 or no network is a clear exit 4; elsewhere than CI it refuses to go online', async () => {
  const cache = mkdtempSync(join(tmpdir(), 'rehearsal-blocked-'));
  const out = [];
  const err = [];
  const io = { env: { GITHUB_ACTIONS: 'true' }, out: (s) => out.push(s), err: (s) => err.push(s), now: () => NOW, sleep: async () => {} };
  const blocked = async () => new Response('{"code":0,"msg":"Service unavailable from a restricted location"}', { status: 451 });
  assert.equal(await cli(['--from', '2026-11-01', '--days', '2', '--cache', cache, '--fetch-only'], { ...io, fetchImpl: blocked }), 4);
  assert.match(err.join('\n'), /cannot reach data-api\.binance\.vision from this machine: HTTP 451: .*restricted location/);
  const down = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) }); };
  assert.equal(await cli(['--from', '2026-11-01', '--days', '2', '--cache', cache, '--fetch-only'], { ...io, fetchImpl: down }), 4);
  assert.match(err.join('\n'), /cannot reach data-api\.binance\.vision from this machine: ENOTFOUND/);
  err.length = 0;
  let called = 0;
  const never = async () => { called += 1; };
  assert.equal(await cli(['--from', '2026-11-01', '--days', '2', '--cache', cache], { ...io, env: {}, fetchImpl: never }), 2);
  assert.match(err.join('\n'), /runs only on GitHub's runners/);
  assert.equal(called, 0);
  assert.equal(await cli(['--from', '2026-11-01', '--days', '2', '--cache', cache, '--offline'], { ...io, env: {}, fetchImpl: never }), 2);
  assert.match(err.join('\n'), /no candles for BTCUSDT 1m 2026-10-31/);
  assert.equal(called, 0);
});
