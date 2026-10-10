#!/usr/bin/env node
// S0 dress rehearsal: a whole mini season, end to end, on real Binance candles from
// the past, with a simulated clock.
//
//   1. Candles: the window's 1-minute candles for the six symbols (plus the day before,
//      so the market snapshot is whole from the first minute) and BTC daily candles from
//      20 days before, fetched once into --cache through the same Binance gate as
//      `tal arena recompute` (≤ 12 requests in any 60 s; days already there are not asked
//      for again). Then the cache is checked for missing, doubled or broken candles.
//   2. Season: the real front door (worker/index.js on its D1 schema, via node:sqlite) and
//      the real engine loop (engine/main.js) run on a fake clock that steps --step seconds
//      at a time (20, like the service) from day D 00:00 to D+days 00:00 UTC. The engine's
//      Binance requests go through its own gate to a stand-in that answers from the cache,
//      so the season itself is offline. The three baselines run, and two scripted agents
//      send signed orders through the guard's arena mode (ArenaGuard), like real agents.
//   3. Copies: arena-data's scripts/snapshot.mjs copies the running board at a cut in mid
//      season (--live), and after the end the season, its weekly boards and ledgers.
//   4. Recompute: `tal arena recompute` on every closed week, the season and the live copy,
//      from the same cached candles. Every one must say "Everything matches".
//
//   node arena/rehearsal/run.mjs [--from YYYY-MM-DD] [--days 6] [--cache DIR] [--offline]
//        [--fetch-only] [--step 20] [--season S0] [--work DIR] [--arena-data DIR] [--allow-binance]
//
// Binance is asked only in step 1, and only on GitHub's runners (GITHUB_ACTIONS=true) or
// with --allow-binance (on the arena server). Anywhere else use --offline with a cache.
//
// Exit codes: 0 all good · 1 a mismatch, or the engine could not finish the season
// · 2 could not run (bad flags, candles missing offline) · 3 Binance said stop (418/403)
// · 4 Binance cannot be reached from this machine (blocked, 451, network).

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { ArenaGuard } from '../../guard/src/arena-guard.js';
import { BannedError } from '../../guard/src/arena/binance-gate.js';
import { createKlines, MissingCandlesError } from '../../guard/src/arena/klines.js';
import { main as tal } from '../../guard/src/cli.js';
import { defaultConfig, saveConfig } from '../../guard/src/config.js';
import { DEFAULT_SYMBOLS } from '../../guard/src/rules.js';
import { EngineLoop } from '../engine/main.js';
import { d1 } from '../test/d1shim.mjs';
import { handle } from '../worker/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SYMBOLS = [...DEFAULT_SYMBOLS];
const API = 'https://arena.rehearsal.invalid/api/arena/v0';
const BINANCE_HOST = 'data-api.binance.vision';
const VERSION = JSON.parse(readFileSync(join(HERE, '../../guard/package.json'), 'utf8')).version;
const BASELINE_IDS = ['baseline-hold', 'baseline-dca', 'baseline-ma'];

const iso = (ms) => new Date(ms).toISOString();
const dayId = (ms) => iso(ms).slice(0, 10);
const isoMin = (ms) => `${iso(ms).slice(0, 16).replace('T', ' ')}`;

export class RehearsalError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// ---------- the window ----------

/** The newest Wednesday 00:00 UTC whose `days`-day window is over before today (S0 also starts on a Wednesday). */
export function defaultFrom(now, days = 6) {
  const today = Math.floor(now / DAY) * DAY;
  let d = today - days * DAY;
  while (new Date(d).getUTCDay() !== 3) d -= DAY;
  return d;
}

/** Where to cut the live copy: 06:00 on the first Monday inside the season (a closed week exists), else mid-season 06:00. */
export function liveCut(from, to) {
  for (let d = from + DAY; d < to; d += DAY) {
    if (new Date(d).getUTCDay() === 1 && d + 6 * HOUR < to - HOUR) return d + 6 * HOUR;
  }
  const mid = from + Math.floor((to - from) / DAY / 2) * DAY + 6 * HOUR;
  return Math.min(mid, to - HOUR);
}

// ---------- 1: candles ----------

/** Fetches what the window needs into `cache` (or checks it is there, offline). */
export async function fetchCandles({ cache, from, to, offline, fetchImpl, now, sleep, log }) {
  const http = [];
  let lastNetError = null;
  // Remember why a request failed, so a blocked runner gets a clear message.
  const watched = async (url, init) => {
    try {
      const res = await fetchImpl(url, init);
      if (res.status === 451 || res.status === 403 || res.status === 418) {
        let text = '';
        try { text = (await res.clone().text()).replace(/\s+/g, ' ').slice(0, 160); } catch { /* no body */ }
        lastNetError = `HTTP ${res.status}${text ? `: ${text}` : ''}`;
      }
      return res;
    } catch (err) {
      lastNetError = `${err?.cause?.code ?? err?.cause?.message ?? err?.name ?? 'Error'}: ${err?.message}`;
      throw err;
    }
  };
  const k = createKlines({
    dir: cache, offline, fetchImpl: watched, now, sleep, userAgent: `tal-rehearsal/${VERSION}`, log,
    http: () => http.push(now()),
  });
  const warm = from - DAY;
  try {
    for (const s of SYMBOLS) await k.range(s, '1m', warm, to);
    await k.range('BTCUSDT', '1d', from - 20 * DAY, to);
  } catch (err) {
    if (err instanceof MissingCandlesError) throw new RehearsalError(`${err.message} in ${cache} (offline: fetch them first, on GitHub's runners or the arena server)`, 2);
    if (err instanceof BannedError) throw new RehearsalError(`${err.message} (${BINANCE_HOST} answered ${lastNetError ?? '418/403'}; from a GitHub runner this usually means the region is blocked)`, 3);
    if (/HTTP 451|fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|timeout|aborted/i.test(`${err.message} ${lastNetError ?? ''}`)) {
      throw new RehearsalError(`cannot reach ${BINANCE_HOST} from this machine: ${lastNetError ?? err.message}`, 4);
    }
    throw err;
  }
  let peak = 0;
  for (const t of http) peak = Math.max(peak, http.filter((u) => u > t - MINUTE && u <= t).length);
  return { requests: k.stats.requests, daysFromDisk: k.stats.daysFromDisk, daysDownloaded: k.stats.daysDownloaded, peakPerMinute: peak };
}

/** Reads the cache back: sorted unique rows per symbol, plus what looks wrong in it. */
export function loadCandles({ cache, from, to }) {
  const warm = from - DAY;
  const minutes = {};
  const anomalies = [];
  const perSymbol = {};
  const readDay = (s, interval, day) => {
    const f = join(cache, s, interval, `${day}.json`);
    if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
    const csv = join(cache, `${s}-${interval}-${day}.csv`);
    if (existsSync(csv)) {
      return readFileSync(csv, 'utf8').split(/\r?\n/).filter((l) => /^\d/.test(l)).map((l) => {
        const [t, o, h, lo, c, v] = l.split(',');
        let ms = Number(t);
        if (ms > 1e14) ms = Math.floor(ms / 1000);
        return [ms, o, h, lo, c, v];
      });
    }
    return null;
  };
  for (const s of SYMBOLS) {
    const byT = new Map();
    let dup = 0;
    let bad = 0;
    let zeroVol = 0;
    for (let d = warm; d < to; d += DAY) {
      const rows = readDay(s, '1m', dayId(d));
      if (!rows) continue;
      for (const r of rows) {
        if (r[0] < d || r[0] >= d + DAY || r[0] % MINUTE !== 0) { bad += 1; continue; }
        if (byT.has(r[0])) dup += 1;
        const [o, h, l, c, v] = r.slice(1, 6).map(Number);
        if (![o, h, l, c, v].every(Number.isFinite) || h < l || o > h || o < l || c > h || c < l || o <= 0) bad += 1;
        if (v === 0) zeroVol += 1;
        byT.set(r[0], r);
      }
    }
    const rows = [...byT.values()].sort((a, b) => a[0] - b[0]);
    minutes[s] = rows;
    // Missing minutes inside the season (the warm-up day only feeds the snapshot).
    const gaps = [];
    let missing = 0;
    for (let t = from; t < to; t += MINUTE) {
      if (byT.has(t)) continue;
      missing += 1;
      const g = gaps[gaps.length - 1];
      if (g && g.to === t) g.to = t + MINUTE;
      else gaps.push({ from: t, to: t + MINUTE });
    }
    let warmMissing = 0;
    for (let t = warm; t < from; t += MINUTE) if (!byT.has(t)) warmMissing += 1;
    perSymbol[s] = { expected: (to - from) / MINUTE, have: (to - from) / MINUTE - missing, missing, gaps, dup, bad, zeroVol, warmMissing };
    for (const g of gaps) anomalies.push(`${s}: no 1-minute candle ${isoMin(g.from)}–${isoMin(g.to)} UTC (${(g.to - g.from) / MINUTE} min)`);
    if (dup) anomalies.push(`${s}: ${dup} minutes saved more than once in the cache`);
    if (bad) anomalies.push(`${s}: ${bad} candles with impossible values or times`);
    if (warmMissing) anomalies.push(`${s}: ${warmMissing} minutes missing on the warm-up day (snapshot only)`);
  }
  const daily = new Map();
  for (let d = from - 20 * DAY; d < to; d += DAY) {
    for (const r of readDay('BTCUSDT', '1d', dayId(d)) ?? []) if (r[0] === d) daily.set(d, r);
  }
  const maDays = [];
  for (let d = from; d < to; d += DAY) {
    let n = 0;
    for (let x = d - 20 * DAY; x < d; x += DAY) if (daily.has(x)) n += 1;
    maDays.push({ day: dayId(d), closes: n });
    if (n < 20) anomalies.push(`BTCUSDT daily: only ${n} of the 20 closes before ${dayId(d)}; the 20-day MA baseline does nothing that day (engine and recompute alike)`);
  }
  return { minutes, daily, perSymbol, maDays, anomalies };
}

// ---------- 2: the season ----------

const lowerBound = (rows, t) => {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/**
 * A stand-in for Binance's public klines endpoint that answers from the cache, as
 * Binance would at the fake clock's time (candles that have opened by then; minutes
 * with no candle are skipped, as Binance skips them).
 */
export function cachedBinance({ minutes, daily, clock }) {
  const asked = [];
  const f = async (url) => {
    const u = new URL(url);
    if (u.host !== BINANCE_HOST || u.pathname !== '/api/v3/klines') return new Response('{}', { status: 404 });
    asked.push(clock.t);
    const q = u.searchParams;
    const symbol = q.get('symbol');
    const interval = q.get('interval');
    const limit = Number(q.get('limit') ?? 500);
    const start = q.get('startTime') != null ? Number(q.get('startTime')) : null;
    const now = clock.t;
    let out = [];
    if (interval === '1m') {
      const rows = minutes[symbol] ?? [];
      const from = start ?? Math.floor(now / MINUTE) * MINUTE - (limit - 1) * MINUTE;
      for (let i = lowerBound(rows, from); i < rows.length && out.length < limit && rows[i][0] <= now; i++) out.push(rows[i]);
      out = out.map((r) => [r[0], r[1], r[2], r[3], r[4], r[5], r[0] + MINUTE - 1]);
    } else if (interval === '1h') {
      const rows = minutes[symbol] ?? [];
      const cur = Math.floor(now / HOUR) * HOUR;
      const first = start ?? cur - (limit - 1) * HOUR;
      for (let h = first; h <= cur && out.length < limit; h += HOUR) {
        const i0 = lowerBound(rows, h);
        let bar = null;
        for (let i = i0; i < rows.length && rows[i][0] < h + HOUR && rows[i][0] <= now; i++) {
          const r = rows[i];
          if (!bar) bar = [h, r[1], r[2], r[3], r[4], Number(r[5])];
          else {
            if (Number(r[2]) > Number(bar[2])) bar[2] = r[2];
            if (Number(r[3]) < Number(bar[3])) bar[3] = r[3];
            bar[4] = r[4];
            bar[5] += Number(r[5]);
          }
        }
        if (bar) out.push([bar[0], bar[1], bar[2], bar[3], bar[4], bar[5].toFixed(8), h + HOUR - 1]);
      }
    } else if (interval === '1d' && symbol === 'BTCUSDT') {
      const cur = Math.floor(now / DAY) * DAY;
      const first = start ?? cur - (limit - 1) * DAY;
      for (let d = first; d <= cur && out.length < limit; d += DAY) {
        const r = daily.get(d);
        if (r) out.push([r[0], r[1], r[2], r[3], r[4], r[5], d + DAY - 1]);
      }
    }
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
  };
  f.asked = asked;
  return f;
}

/** Two scripted agents. They decide only from what the arena publishes (snapshot, account), and send through ArenaGuard. */
function scriptedAgents({ work, fetchImpl, clock }) {
  const get = async (path) => {
    const res = await fetchImpl(`${API}${path}`);
    return res.ok ? res.json() : null;
  };
  const make = (agentId, name) => {
    const root = join(work, 'agents', agentId);
    saveConfig(root, { ...defaultConfig(agentId), venue: 'arena', arena_url: API });
    let posts = 0; // orders that left this machine (POST /orders)
    const counted = async (url, init = {}) => {
      if (init.method === 'POST') posts += 1;
      return fetchImpl(url, init);
    };
    const guard = new ArenaGuard({ root, market: null, now: () => clock.t, fetchImpl: counted });
    const stats = { sent: 0, localRefused: {}, refusedOnSend: {} };
    const done = new Set();
    const place = async (args) => {
      const before = posts;
      const r = await guard.placeOrder(args, 'agent');
      if (r.status === 'sent') stats.sent += 1;
      else if (posts > before) stats.refusedOnSend[r.rule] = (stats.refusedOnSend[r.rule] ?? 0) + 1; // the front door said no
      else stats.localRefused[r.rule] = (stats.localRefused[r.rule] ?? 0) + 1; // never left this machine
      return r;
    };
    /** Run `fn` once per UTC day at hh:mm:05 (or the first tick after it, within 30 minutes). */
    const daily = async (t, hour, tag, fn) => {
      const d = Math.floor(t / DAY) * DAY;
      const at = d + hour * HOUR + 5_000;
      const key = `${dayId(d)}#${tag}`;
      if (t >= at && t < at + 30 * MINUTE && !done.has(key)) {
        done.add(key);
        await fn();
      }
    };
    return { agentId, name, model: 'Scripted rule, S0 rehearsal', guard, stats, done, place, daily, get };
  };

  // 1. Follows the 24-hour change in the arena's own snapshot, every two hours.
  const trend = make('rehearsal-trend', 'Rehearsal Trend');
  trend.act = async (t) => {
    const slot = Math.floor(t / (2 * HOUR));
    if (t - slot * 2 * HOUR >= 15_000 && !trend.done.has(`slot${slot}`)) {
      trend.done.add(`slot${slot}`);
      const snap = await trend.get('/snapshot.json');
      const acct = await trend.get(`/accounts/${trend.agentId}.json`);
      if (snap?.markets && acct) {
        for (const s of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT']) {
          const m = snap.markets[s];
          if (!m) continue;
          const pos = acct.positions.find((p) => p.symbol === s);
          const pct = pos ? (Number(pos.valueUsdt) / Number(acct.equityUsdt)) * 100 : 0;
          if (m.change24hPct >= 0.5 && pct < 20) {
            await trend.place({ symbol: s, side: 'buy', usdt: 400, reason: `24h change ${m.change24hPct}% in the arena snapshot: add 400 USDT` });
          } else if (m.change24hPct <= -0.5 && pos) {
            await trend.place({ symbol: s, side: 'sell', qty: 'all', reason: `24h change ${m.change24hPct}% in the arena snapshot: take it off` });
          }
        }
      }
    }
    // Once a day, an order too big for the 10%-per-order lock: the guard refuses it on this machine.
    await trend.daily(t, 23, 'too-big', () => trend.place({ symbol: 'BTCUSDT', side: 'buy', usdt: 5000, reason: 'rehearsal: too big on purpose' }));
  };

  // 2. Tests the locks the arena checks at fill time: 14 orders in one minute (12 an hour pass).
  const burst = make('rehearsal-burst', 'Rehearsal Burst');
  burst.act = async (t) => {
    await burst.daily(t, 1, 'nothing-to-sell', () => burst.place({ symbol: 'XRPUSDT', side: 'sell', qty: 'all', reason: 'rehearsal: selling a coin it does not hold' }));
    await burst.daily(t, 12, 'burst', async () => {
      for (let i = 1; i <= 14; i++) await burst.place({ symbol: 'DOGEUSDT', side: 'buy', usdt: 15, reason: `rehearsal: order ${i} of 14 in one minute (12 an hour are allowed)` });
    });
    await burst.daily(t, 16, 'sell-some', async () => {
      const acct = await burst.get(`/accounts/${burst.agentId}.json`);
      if (acct?.positions.some((p) => p.symbol === 'DOGEUSDT' && Number(p.valueUsdt) > 60)) {
        await burst.place({ symbol: 'DOGEUSDT', side: 'sell', usdt: 50, reason: 'rehearsal: sell 50 USDT worth' });
      }
    });
    await burst.daily(t, 20, 'sell-all', async () => {
      const acct = await burst.get(`/accounts/${burst.agentId}.json`);
      if (acct?.positions.some((p) => p.symbol === 'DOGEUSDT')) await burst.place({ symbol: 'DOGEUSDT', side: 'sell', qty: 'all', reason: 'rehearsal: sell all of it' });
    });
  };
  return [trend, burst];
}

/** Where arena-data's scripts/snapshot.mjs is, or null. */
export function snapshotPath(arenaData) {
  const tries = [
    arenaData && join(resolve(arenaData), 'scripts/snapshot.mjs'),
    join(HERE, '../../../arena-data/scripts/snapshot.mjs'), // both repositories side by side
    join(HERE, '../../.arena-data/scripts/snapshot.mjs'), // checked out inside (GitHub Actions)
  ].filter(Boolean);
  return { found: tries.find((p) => existsSync(p)) ?? null, tries };
}

async function importSnapshot(arenaData) {
  const { found, tries } = snapshotPath(arenaData);
  if (!found) throw new RehearsalError(`cannot find arena-data's scripts/snapshot.mjs (looked in ${tries.join(', ')}); pass --arena-data DIR`, 2);
  return (await import(pathToFileURL(found).href)).snapshot;
}

/** Runs the season on the fake clock. Returns what the report needs. */
async function runSeason({ season, candles, work, step, snapshot, log }) {
  const clock = { t: season.from + 10_000 };
  const env = { DB: d1([join(HERE, '../worker/schema.sql')]) };
  const binance = cachedBinance({ minutes: candles.minutes, daily: candles.daily, clock });
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith(API)) return handle(new Request(url, init), env, clock.t);
    return binance(url, init);
  };
  const agents = scriptedAgents({ work, fetchImpl, clock });
  const roster = [];
  for (const a of agents) roster.push({ ...(await a.guard.signup({ name: a.name, model: a.model })), joined: iso(season.from) });
  const rosterFile = join(work, 'roster.json');
  writeFileSync(rosterFile, `${JSON.stringify(roster, null, 2)}\n`);
  const pauseDir = join(work, 'pause');
  mkdirSync(pauseDir, { recursive: true });
  const engineLog = [];
  const loop = new EngineLoop({
    config: {
      api: API, home: join(work, 'engine'), roster: rosterFile, baselines: BASELINE_IDS, pauseDir, season, pollSec: step,
      priceSource: 'binance', source: 'TradeAgents Lab arena · paper trading at Binance spot prices (S0 rehearsal)',
    },
    fetchImpl, now: () => clock.t, log: (s) => engineLog.push(`${iso(clock.t)} ${s}`), out: () => {},
  });
  env.ENGINE_PUBKEY = loop.pubkey();

  const cut = liveCut(season.from, season.to);
  const liveDir = join(work, 'live');
  const dataDir = join(work, 'arena-data');
  let live = null;
  let rounds = 0;
  const end = season.to + 3 * MINUTE;
  const roundErrors = [];
  let lastProgress = 0;
  for (;;) {
    for (const a of agents) await a.act(clock.t);
    try {
      await loop.once();
    } catch (err) {
      if (err instanceof BannedError) throw err;
      roundErrors.push(`${iso(clock.t)} ${err.message}`);
    }
    rounds += 1;
    if (!live && loop.arena.minute === cut - MINUTE) {
      await snapshot({ api: API, root: liveDir, now: clock.t, fetchImpl, live: true, season: season.id, log: () => {} });
      const board = JSON.parse(readFileSync(join(liveDir, 'standings/latest.json'), 'utf8'));
      live = { cut, asOf: board.asOf, week: board.period.id };
    }
    if (clock.t >= end && (loop.arena.seasonClosed || clock.t >= end + 10 * MINUTE)) break;
    if (clock.t - lastProgress >= DAY) {
      lastProgress = clock.t;
      log(`  ... ${isoMin(clock.t)} UTC, settled to ${loop.arena.minute == null ? '-' : isoMin(loop.arena.minute)}`);
    }
    let next = clock.t + step * 1000;
    // Never step over the moment the board reaches the cut (asOf = cut needs a round 20–80 s after it).
    if (!live && clock.t < cut + 30_000 && next > cut + 30_000) next = cut + 30_000;
    clock.t = next;
  }
  await snapshot({ api: API, root: dataDir, now: clock.t, fetchImpl, season: season.id, log: () => {} });

  const settledTo = loop.arena.minute == null ? null : loop.arena.minute + MINUTE;
  let stall = null;
  if (!loop.arena.seasonClosed) {
    const m = settledTo ?? season.from;
    const gone = SYMBOLS.filter((s) => lowerBound(candles.minutes[s], m) >= candles.minutes[s].length || candles.minutes[s][lowerBound(candles.minutes[s], m)][0] !== m);
    stall = { at: m, symbols: gone };
  }
  let peak = 0;
  const asked = binance.asked;
  for (let i = 0, j = 0; i < asked.length; i++) {
    while (asked[j] <= asked[i] - MINUTE) j += 1;
    peak = Math.max(peak, i - j + 1);
  }
  return {
    clock, loop, agents, live, liveDir, dataDir, rounds, stall, settledTo, roundErrors, engineLog,
    engineRequests: asked.length, enginePeakPerMinute: peak, arenaKey: loop.pubkey(),
  };
}

// ---------- 3 and 4: what was published, and the recompute ----------

function readJsonIf(f) {
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
}

/** Per agent, from the copied ledgers: what was sent, taken, refused and filled. */
function tally(dataDir) {
  const out = {};
  const led = join(dataDir, 'ledgers');
  if (!existsSync(led)) return out;
  for (const agent of readdirSync(led).sort()) {
    const t = { orderLines: 0, taken: 0, refusedOnArrival: {}, refusedAtFill: {}, buys: 0, sells: 0, fees: 0, out: false };
    for (const f of readdirSync(join(led, agent)).sort()) {
      const doc = JSON.parse(readFileSync(join(led, agent, f), 'utf8'));
      t.orderLines += doc.orders.length;
      for (const line of doc.results) {
        const ev = JSON.parse(line);
        const d = ev.data;
        if (ev.type === 'recv') t.taken += 1;
        else if (ev.type === 'reject') {
          const bucket = d.recv != null ? t.refusedOnArrival : t.refusedAtFill;
          bucket[d.rule] = (bucket[d.rule] ?? 0) + 1;
        } else if (ev.type === 'fill') {
          if (d.side === 'buy') t.buys += 1;
          else t.sells += 1;
          t.fees += Number(d.fee);
        } else if (ev.type === 'out') t.out = true;
      }
    }
    out[agent] = t;
  }
  return out;
}

async function recomputeOne({ label, args, cache, arenaKey, now }) {
  const out = [];
  const err = [];
  const io = {
    env: { LANG: 'en_US.UTF-8', HOME: tmpdir() },
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    now: () => now,
    fetch: async () => { throw new Error('the rehearsal recompute never goes online'); },
    sleep: async () => {},
  };
  const code = await tal(['arena', 'recompute', ...args, '--candles', cache, '--arena-key', arenaKey], io);
  const text = out.join('\n');
  const ok = code === 0 && /Everything matches/.test(text);
  const last = [...out].reverse().find((l) => l.trim()) ?? err.filter((l) => !l.startsWith('...')).join(' ');
  const lines = text.split('\n');
  const diffAt = lines.indexOf('Differences:');
  return { label, code, ok, last, differences: diffAt === -1 ? [] : lines.slice(diffAt + 1, diffAt + 13).filter((l) => l.startsWith('  ')), errors: err.filter((l) => !l.startsWith('...')) };
}

// ---------- the whole rehearsal ----------

export async function rehearse({
  from, days = 6, cache, offline = false, fetchOnly = false, step = 20, seasonId = 'S0', work, arenaData,
  fetchImpl = globalThis.fetch, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {},
} = {}) {
  const t0 = performance.now();
  if (!Number.isInteger(days) || days < 1 || days > 14) throw new RehearsalError('--days: 1 to 14', 2);
  if (!/^S\d{1,3}$/.test(seasonId)) throw new RehearsalError('--season: an id like S0', 2);
  if (!Number.isFinite(step) || step < 1 || step > 300) throw new RehearsalError('--step: 1 to 300 seconds', 2);
  const season = { id: seasonId, from, to: from + days * DAY };
  if (from % DAY !== 0) throw new RehearsalError('--from must be a date (00:00 UTC)', 2);
  if (season.to + 2 * MINUTE > now()) throw new RehearsalError(`the window ${dayId(season.from)} → ${dayId(season.to)} is not over yet; pick an earlier --from`, 2);
  const timing = {};
  const rep = { season: { id: seasonId, from: iso(season.from), to: iso(season.to) }, ok: false, timing };

  log(`candles: ${offline ? 'from the cache only' : `fetching what ${cache} lacks from ${BINANCE_HOST}`}`);
  rep.fetch = await fetchCandles({ cache, from: season.from, to: season.to, offline, fetchImpl, now, sleep, log });
  const candles = loadCandles({ cache, from: season.from, to: season.to });
  rep.candles = { perSymbol: candles.perSymbol, maDays: candles.maDays, anomalies: candles.anomalies };
  timing.candlesSec = (performance.now() - t0) / 1000;
  if (fetchOnly) {
    rep.ok = true;
    rep.fetchOnly = true;
    return rep;
  }

  const snapshot = await importSnapshot(arenaData);
  const dir = work ?? mkdtempSync(join(tmpdir(), 'tal-rehearsal-'));
  mkdirSync(dir, { recursive: true });
  rep.work = dir;
  log(`season: ${seasonId} ${iso(season.from)} → ${iso(season.to)}, clock steps ${step} s (work dir ${dir})`);
  const t1 = performance.now();
  const s = await runSeason({ season, candles, work: dir, step, snapshot, log });
  timing.seasonSec = (performance.now() - t1) / 1000;
  rep.rounds = s.rounds;
  rep.engine = {
    binanceRequests: s.engineRequests, peakPerMinute: s.enginePeakPerMinute, settledTo: s.settledTo == null ? null : iso(s.settledTo),
    seasonClosed: s.loop.arena.seasonClosed, stall: s.stall && { at: iso(s.stall.at), symbols: s.stall.symbols },
    roundErrors: s.roundErrors.slice(0, 10), roundErrorCount: s.roundErrors.length,
    log: s.engineLog.filter((l) => !/requests allowed again|requests in the last/.test(l)).slice(0, 10),
  };
  rep.arenaKey = s.arenaKey;

  const ledgerTally = tally(s.dataDir);
  rep.agents = {};
  for (const id of [...BASELINE_IDS, ...s.agents.map((a) => a.agentId)]) {
    const g = s.agents.find((a) => a.agentId === id);
    rep.agents[id] = { ...(ledgerTally[id] ?? {}), ...(g ? { sent: g.stats.sent, localRefused: g.stats.localRefused, refusedOnSend: g.stats.refusedOnSend } : {}) };
  }
  const weekly = existsSync(join(s.dataDir, 'weekly')) ? readdirSync(join(s.dataDir, 'weekly')).filter((f) => /^\d{4}-W\d{2}\.json$/.test(f)).map((f) => f.slice(0, -5)).sort() : [];
  const seasonBoard = readJsonIf(join(s.dataDir, `season/${seasonId}.json`));
  rep.boards = {
    weekly: weekly.map((id) => {
      const b = readJsonIf(join(s.dataDir, `weekly/${id}.json`));
      return { id, asOf: b.asOf, rows: b.rows.length, top: b.rows[0]?.agentId };
    }),
    season: seasonBoard && { id: seasonId, asOf: seasonBoard.asOf, rows: seasonBoard.rows.map((r) => ({ rank: r.rank, agentId: r.agentId, returnPct: r.returnPct, maxDrawdownPct: r.maxDrawdownPct, score: r.score, trades: r.trades, status: r.status })) },
    live: s.live,
  };

  log('recompute: every closed week, the season, and the live copy');
  const t2 = performance.now();
  const checks = [];
  const nowRec = s.clock.t;
  for (const id of weekly) checks.push(await recomputeOne({ label: `week ${id}`, args: ['--data', s.dataDir, '--week', id], cache, arenaKey: s.arenaKey, now: nowRec }));
  if (seasonBoard) checks.push(await recomputeOne({ label: `season ${seasonId}`, args: ['--data', s.dataDir, '--season', seasonId], cache, arenaKey: s.arenaKey, now: nowRec }));
  if (s.live) checks.push(await recomputeOne({ label: `live ${s.live.week} as of ${s.live.asOf}`, args: ['--data', s.liveDir, '--live'], cache, arenaKey: s.arenaKey, now: nowRec }));
  timing.recomputeSec = (performance.now() - t2) / 1000;
  rep.recompute = checks;

  const problems = [];
  if (s.stall) problems.push(`the engine stopped at ${iso(s.stall.at)}: no 1-minute candle for ${s.stall.symbols.join(', ') || '(?)'}; it would wait there for ever`);
  if (!seasonBoard) problems.push('no season board was published');
  if (!s.live) problems.push(`the live board never reached the cut ${iso(liveCut(season.from, season.to))}`);
  const wantWeeks = new Set();
  for (let t = season.from; t < season.to; t += DAY) {
    const d = new Date(t);
    const dow = (d.getUTCDay() + 6) % 7;
    const mon = t - dow * DAY;
    const thu = new Date(mon + 3 * DAY);
    const wk = Math.floor((thu.getTime() - Date.UTC(thu.getUTCFullYear(), 0, 1)) / DAY / 7) + 1;
    wantWeeks.add(`${thu.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`);
  }
  for (const w of wantWeeks) if (!weekly.includes(w)) problems.push(`weekly board ${w} missing`);
  if (s.enginePeakPerMinute > 12) problems.push(`the engine asked "Binance" ${s.enginePeakPerMinute} times in one minute (budget 12)`);
  if (rep.fetch.peakPerMinute > 12) problems.push(`the candle download made ${rep.fetch.peakPerMinute} requests in one minute (budget 12)`);
  for (const c of checks) if (!c.ok) problems.push(`recompute ${c.label}: ${c.last}`);
  rep.problems = problems;
  rep.ok = problems.length === 0;
  timing.totalSec = (performance.now() - t0) / 1000;
  return rep;
}

// ---------- printing ----------

const pad = (s, n) => String(s).padEnd(n);
const rules = (o) => {
  const e = Object.entries(o ?? {});
  return e.length ? e.map(([k, v]) => `${k}×${v}`).join(' ') : '-';
};

export function formatRehearsal(rep) {
  const L = [];
  L.push(`S0 rehearsal · season ${rep.season.id} ${rep.season.from} → ${rep.season.to} · real Binance spot candles, simulated clock`);
  L.push('');
  const f = rep.fetch;
  L.push(`Candles (warm-up day + season, ${SYMBOLS.length} symbols × 1m, BTCUSDT × 1d from 20 days before)`);
  L.push(`  requests to ${BINANCE_HOST}: ${f.requests} (peak ${f.peakPerMinute} in any 60 s; budget 12) · days from cache ${f.daysFromDisk}, downloaded ${f.daysDownloaded}`);
  for (const [s, p] of Object.entries(rep.candles.perSymbol)) {
    L.push(`  ${pad(s, 9)} ${p.have}/${p.expected} minutes in the season, ${p.missing} missing, ${p.gaps.length} gap(s), ${p.dup} doubled, ${p.bad} broken, ${p.zeroVol} with no trades${p.warmMissing ? `, ${p.warmMissing} missing on the warm-up day` : ''}`);
  }
  const ma = rep.candles.maDays.filter((d) => d.closes < 20);
  L.push(`  BTCUSDT daily: ${ma.length ? `${ma.length} day(s) without 20 closes before them` : `20 closes before each of the ${rep.candles.maDays.length} days`}`);
  L.push(rep.candles.anomalies.length ? '  anomalies:' : '  anomalies: none');
  for (const a of rep.candles.anomalies.slice(0, 20)) L.push(`    - ${a}`);
  if (rep.candles.anomalies.length > 20) L.push(`    ... and ${rep.candles.anomalies.length - 20} more`);
  if (rep.fetchOnly) {
    L.push('', `Candles ready (${rep.timing.candlesSec.toFixed(1)} s). --fetch-only: no season run.`);
    return L;
  }
  const e = rep.engine;
  L.push('');
  L.push(`Engine: ${rep.rounds} rounds · ${e.binanceRequests} Binance requests (answered from the cache; peak ${e.peakPerMinute} in any 60 s) · settled to ${e.settledTo ?? '-'} · season ${e.seasonClosed ? 'closed' : 'NOT closed'}`);
  if (e.stall) L.push(`  STOPPED at ${e.stall.at}: no candle for ${e.stall.symbols.join(', ')}. The engine waits for that minute for ever; the recompute refuses to replay past it.`);
  if (e.roundErrorCount) L.push(`  ${e.roundErrorCount} round(s) failed, first: ${e.roundErrors[0]}`);
  L.push('');
  L.push(`${pad('agent', 18)}${pad('sent', 6)}${pad('refused here', 22)}${pad('taken', 7)}${pad('refused on arrival', 20)}${pad('refused at fill', 24)}${pad('fills b/s', 11)}fees USDT`);
  for (const [id, a] of Object.entries(rep.agents)) {
    const sent = a.sent ?? a.taken ?? 0;
    L.push(`${pad(id, 18)}${pad(a.sent ?? `(${sent})`, 6)}${pad(a.localRefused ? rules(a.localRefused) : 'n/a', 22)}${pad(a.taken ?? 0, 7)}${pad(rules(a.refusedOnArrival), 20)}${pad(rules(a.refusedAtFill), 24)}${pad(`${a.buys ?? 0}/${a.sells ?? 0}`, 11)}${(a.fees ?? 0).toFixed(2)}${a.out ? '  OUT' : ''}`);
  }
  L.push('  (baselines place their orders inside the engine: "sent" in brackets is what the engine took for them)');
  L.push('');
  L.push('Boards published and copied by arena-data\'s snapshot.mjs:');
  for (const w of rep.boards.weekly) L.push(`  weekly ${w.id}: ${w.rows} rows, as of ${w.asOf}, top ${w.top}`);
  if (rep.boards.season) {
    L.push(`  season ${rep.boards.season.id}: as of ${rep.boards.season.asOf}`);
    for (const r of rep.boards.season.rows) L.push(`    ${pad(r.rank, 3)}${pad(r.agentId, 18)} return ${pad(`${r.returnPct}%`, 9)} max dd ${pad(`${r.maxDrawdownPct}%`, 8)} score ${pad(r.score, 7)} trades ${pad(r.trades, 4)} ${r.status}`);
  } else L.push('  season board: none');
  L.push(rep.boards.live ? `  live board ${rep.boards.live.week} as of ${rep.boards.live.asOf} (copied with --live)` : '  live board: not copied');
  L.push('');
  L.push('tal arena recompute (offline, same cached candles):');
  for (const c of rep.recompute) {
    L.push(`  ${pad(c.label, 44)} exit ${c.code} · ${c.ok ? 'Everything matches' : c.last}`);
    for (const d of c.differences) L.push(`    ${d.trim()}`);
    if (!c.ok) for (const x of c.errors.slice(0, 3)) L.push(`    ${x}`);
  }
  L.push('');
  const t = rep.timing;
  L.push(`Time: candles ${t.candlesSec.toFixed(1)} s · season ${t.seasonSec.toFixed(1)} s · recompute ${t.recomputeSec.toFixed(1)} s · total ${t.totalSec.toFixed(1)} s`);
  L.push(rep.ok ? 'REHEARSAL PASSED: every board recomputes with 0 mismatches.' : `REHEARSAL FAILED:\n${rep.problems.map((p) => `  - ${p}`).join('\n')}`);
  L.push('Simulated trading. Past results don\'t predict future results. Not investment advice.');
  return L;
}

// ---------- command line ----------

export async function cli(argv = process.argv.slice(2), { env = process.env, out = console.log, err = console.error, ...deps } = {}) {
  let o;
  try {
    ({ values: o } = parseArgs({
      args: argv,
      options: {
        from: { type: 'string' }, days: { type: 'string', default: '6' }, cache: { type: 'string', default: '.candles' },
        offline: { type: 'boolean' }, 'fetch-only': { type: 'boolean' }, step: { type: 'string', default: '20' },
        season: { type: 'string', default: 'S0' }, work: { type: 'string' }, 'arena-data': { type: 'string' },
        'allow-binance': { type: 'boolean' }, json: { type: 'string' }, help: { type: 'boolean' },
      },
    }));
  } catch (e) {
    err(e.message);
    return 2;
  }
  if (o.help) {
    out('usage: node arena/rehearsal/run.mjs [--from YYYY-MM-DD] [--days 6] [--cache DIR] [--offline] [--fetch-only] [--step 20] [--season S0] [--work DIR] [--arena-data DIR] [--json FILE] [--allow-binance]');
    return 0;
  }
  const now = deps.now ?? Date.now;
  const days = Number(o.days);
  let from;
  if (o.from) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.from)) { err('--from: a date like 2026-09-30'); return 2; }
    from = Date.parse(`${o.from}T00:00:00Z`);
  } else from = defaultFrom(now(), days);
  const online = !o.offline;
  if (online && env.GITHUB_ACTIONS !== 'true' && !o['allow-binance']) {
    err(`This would ask ${BINANCE_HOST} for candles. That runs only on GitHub's runners (GITHUB_ACTIONS=true) or on the arena server (--allow-binance).`);
    err('Here, use --offline with a cache that already holds the candles.');
    return 2;
  }
  try {
    const rep = await rehearse({
      from, days, cache: resolve(o.cache), offline: !online, fetchOnly: Boolean(o['fetch-only']), step: Number(o.step),
      seasonId: o.season, work: o.work && resolve(o.work), arenaData: o['arena-data'], log: (s) => err(s), now, ...deps,
    });
    for (const l of formatRehearsal(rep)) out(l);
    if (o.json) writeFileSync(o.json, `${JSON.stringify(rep, null, 2)}\n`);
    return rep.ok ? 0 : 1;
  } catch (e) {
    if (e instanceof RehearsalError) {
      err(`rehearsal: ${e.message}`);
      return e.code;
    }
    if (e instanceof BannedError) {
      err(`rehearsal: ${e.message}`);
      return 3;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await cli();
}
