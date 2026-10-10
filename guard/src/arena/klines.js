// Binance spot public candles for recomputing the arena, kept on disk so each
// one is downloaded once.
//
// Layout: <dir>/<SYMBOL>/<interval>/<YYYY-MM-DD>.json, one UTC day per file, each
// a list of [openTime ms, open, high, low, close, volume] (prices as strings, as
// Binance sends them). A day is written only once it is over, so a file never
// changes. Offline, Binance's own daily files also work: <dir>/<SYMBOL>-1m-<day>.csv
// (unzipped from data.binance.vision).
//
// Requests: only data-api.binance.vision, only for days not on disk, 1,000 candles
// per request, at most 12 in any rolling 60 s (the arena engine's gate: 429 →
// wait Retry-After; 418/403 → stop and write <dir>/.pause/arena.pause).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createMarket, INTERVALS } from '../market.js';
import { BUDGET, createBinanceGate, WINDOW_MS } from './binance-gate.js';

const DAY = 86_400_000;
const MINUTE = 60_000;
const PER_REQUEST = 1000;
const MAX_RETRIES = 8;

const dayId = (ms) => new Date(ms).toISOString().slice(0, 10);
const floorDay = (ms) => Math.floor(ms / DAY) * DAY;

/** Candles a recompute needs but cannot find offline. */
export class MissingCandlesError extends Error {
  constructor(missing) {
    const show = missing.slice(0, 5).join(', ');
    super(`no candles for ${show}${missing.length > 5 ? ` and ${missing.length - 5} more days` : ''}`);
    this.missing = missing;
  }
}

/** Binance's CSV (no header, or a header we skip). Times may be in microseconds (spot, 2025 on). */
export function parseBinanceCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^\d/.test(line)) continue;
    const [t, o, h, l, c, v] = line.split(',');
    let ms = Number(t);
    if (ms > 1e14) ms = Math.floor(ms / 1000);
    rows.push([ms, o, h, l, c, v]);
  }
  return rows;
}

/**
 * dir: where candles are read from (and written to, unless offline).
 * offline: never ask Binance; a missing day is an error.
 */
export function createKlines({
  dir, offline = false, fetchImpl = globalThis.fetch, now = Date.now,
  sleep = (ms) => new Promise((res) => setTimeout(res, ms)),
  userAgent = 'tal-recompute', log = () => {}, http = () => {},
  limit = BUDGET, windowMs = WINDOW_MS, maxWaitMs = 15 * MINUTE,
} = {}) {
  const stats = { requests: 0, daysFromDisk: 0, daysDownloaded: 0 };
  const sent = []; // times of requests that actually went out
  let market = null;
  if (!offline) {
    const pauseDir = join(dir, '.pause');
    mkdirSync(pauseDir, { recursive: true });
    const gate = createBinanceGate({
      fetchImpl, now, userAgent, pauseDir, limit, windowMs, log,
      out: (line) => { sent.push(now()); stats.requests += 1; http(line); },
    });
    market = createMarket({ source: 'binance', fetchImpl: gate.fetch, now, userAgent, cacheMs: 0 });
  }

  const file = (symbol, interval, day) => join(dir, symbol, interval, `${day}.json`);

  function readDay(symbol, interval, day) {
    const f = file(symbol, interval, day);
    if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
    const csv = join(dir, `${symbol}-${interval}-${day}.csv`);
    if (existsSync(csv)) return parseBinanceCsv(readFileSync(csv, 'utf8'));
    return null;
  }

  function writeDay(symbol, interval, day, rows) {
    const f = file(symbol, interval, day);
    mkdirSync(join(dir, symbol, interval), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(rows)}\n`);
    renameSync(tmp, f);
  }

  /** One request, inside the budget; waits out 429s and the rolling window. */
  async function request(symbol, interval, startTime, n) {
    for (let tries = 0; ; ) {
      while (sent.length && sent[0] <= now() - windowMs) sent.shift();
      if (sent.length >= limit) {
        await sleep(sent[0] + windowMs - now() + 1);
        continue;
      }
      try {
        const { candles } = await market.candles(symbol, interval, { startTime, limit: n });
        return candles;
      } catch (err) {
        if (err?.banned || !err?.gate) throw err;
        const wait = err.until != null ? err.until - now() : 1000;
        tries += 1;
        if (tries > MAX_RETRIES || wait > maxWaitMs) throw new Error(`${err.message}; stopped, try again later`);
        log(err.message);
        await sleep(Math.max(wait, 1000));
      }
    }
  }

  /** Download [from, to) and return rows by day (only whole, finished days get saved). */
  async function download(symbol, interval, from, to) {
    const step = INTERVALS[interval];
    const end = Math.min(to, Math.floor(now() / step) * step); // never ask for candles that have not opened
    const byDay = new Map();
    for (let t = from; t < end; t += PER_REQUEST * step) {
      const n = Math.min(PER_REQUEST, Math.ceil((end - t) / step));
      // Keep only this request's own span: when Binance has no candle for some minutes
      // inside it, it fills the reply with candles from after the span, which the
      // next request fetches again (they used to be saved twice).
      const spanEnd = Math.min(end, t + n * step);
      for (const k of await request(symbol, interval, t, n)) {
        if (k.t < t || k.t >= spanEnd) continue;
        const d = dayId(k.t);
        if (!byDay.has(d)) byDay.set(d, []);
        byDay.get(d).push([k.t, k.o, k.h, k.l, k.c, k.v]);
      }
    }
    return byDay;
  }

  /**
   * Every candle of `symbol` at `interval` with open time in [from, to), as a Map
   * openTime → [t, o, h, l, c, v]. Reads disk first and downloads only missing days.
   */
  async function range(symbol, interval, from, to) {
    if (!INTERVALS[interval]) throw new RangeError(`interval must be one of ${Object.keys(INTERVALS).join(', ')}`);
    const out = new Map();
    const missing = [];
    for (let d = floorDay(from); d < to; d += DAY) {
      const rows = readDay(symbol, interval, dayId(d));
      if (rows) {
        stats.daysFromDisk += 1;
        for (const r of rows) if (r[0] >= from && r[0] < to) out.set(r[0], r);
      } else missing.push(d);
    }
    if (missing.length && offline) throw new MissingCandlesError(missing.map((d) => `${symbol} ${interval} ${dayId(d)}`));
    // Runs of consecutive missing days, each downloaded in as few requests as possible.
    for (let i = 0; i < missing.length; ) {
      let j = i;
      while (j + 1 < missing.length && missing[j + 1] === missing[j] + DAY) j += 1;
      const runFrom = missing[i];
      const runTo = missing[j] + DAY;
      const byDay = await download(symbol, interval, runFrom, runTo);
      for (let d = runFrom; d < runTo; d += DAY) {
        const rows = byDay.get(dayId(d)) ?? [];
        if (d + DAY + 2 * MINUTE <= now()) {
          writeDay(symbol, interval, dayId(d), rows);
          stats.daysDownloaded += 1;
        }
        for (const r of rows) if (r[0] >= from && r[0] < to) out.set(r[0], r);
      }
      i = j + 1;
    }
    return out;
  }

  return { range, stats, offline };
}
