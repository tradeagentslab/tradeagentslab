// The one door every Binance request from the arena engine goes through.
//
// - Budget: at most `limit` (12) requests in any rolling 60 seconds — normal
//   polling, snapshot seeding and catch-up alike. When the budget is spent the
//   gate refuses (no request is made); the engine simply tries again next round.
// - Shared pause directory (default /var/lib/binance-guard/): before EVERY request
//   every *.pause file there is read. Line 1 = Unix seconds "paused until", optional
//   line 2 = a short reason. If any says "not yet", no request is made. A missing,
//   unreadable or malformed file counts as "not paused". Other programs on the
//   server write their own files (feed2.pause, …); the engine writes only arena.pause.
// - 429: nothing is written; the gate waits Retry-After (or backs off 60 s, 120 s, …
//   up to 10 min) and then carries on within the budget.
// - 418 or 403: the gate writes arena.pause (Retry-After, else now + 2 h), refuses
//   every later request and throws BannedError; the engine logs it and exits
//   non-zero, and the service does not restart itself — a human looks first.
// - Every request sends `user-agent: tal-arena/<version>` and logs one line to
//   stdout:  http <UTC ISO time> <host> <path, no query> <status|error:Name> <ms>ms

import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const BUDGET = 12;
export const WINDOW_MS = 60_000;
// Made by the operator's installer: root:binguard, mode 1775 (sticky). The engine runs
// with the binguard group, so it can create and replace its own arena.pause there.
export const DEFAULT_PAUSE_DIR = '/var/lib/binance-guard';
export const OWN_PAUSE_FILE = 'arena.pause';
const BAN_PAUSE_SEC = 2 * 3600; // 418/403 without Retry-After
const BACKOFF_FIRST_SEC = 60;
const BACKOFF_MAX_SEC = 600;

/** No request was made: budget spent, paused, or backing off after a 429. Try again later. */
export class GateClosedError extends Error {
  constructor(message, until = null) {
    super(message);
    this.gate = true;
    this.until = until;
  }
}

/** Binance answered 418 or 403. Stop asking; exit and wait for a human. */
export class BannedError extends Error {
  constructor(message) {
    super(message);
    this.gate = true;
    this.banned = true;
  }
}

/** Retry-After in seconds (delta seconds or an HTTP date), or null. */
export function retryAfterSec(value, nowMs) {
  if (value == null || value === '') return null;
  const v = String(value).trim();
  if (/^\d+$/.test(v)) return Number(v);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - nowMs) / 1000));
}

/** Read every *.pause file in `dir`; the latest "until" still in the future wins. */
export function readPauses(dir, nowMs) {
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.pause'));
  } catch {
    return null; // no directory → not paused
  }
  let best = null;
  for (const name of names) {
    let text;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue; // unreadable → not paused
    }
    const [first = '', second = ''] = text.split('\n');
    if (!/^\d+$/.test(first.trim())) continue; // empty or malformed → not paused
    const until = Number(first.trim()) * 1000;
    if (!(until > nowMs)) continue;
    if (!best || until > best.until) best = { file: name, until, reason: second.trim() };
  }
  return best;
}

/** Write <dir>/arena.pause: a temp file in the same directory, then rename. */
export function writeOwnPause(dir, untilSec, reason, log = () => {}) {
  const target = join(dir, OWN_PAUSE_FILE);
  const text = `${untilSec}\n${reason}\n`;
  const tmp = join(dir, `.${OWN_PAUSE_FILE}.${process.pid}.tmp`); // not *.pause, so readers skip it
  try {
    writeFileSync(tmp, text, { mode: 0o644 });
    renameSync(tmp, target);
    return target;
  } catch (err) {
    // Should the directory not let us create a temp file (wrong group or mode), try
    // our own arena.pause in place (readers treat a half-written file as "not
    // paused", so the worst case is a moment without pause) and say so in the log.
    try {
      writeFileSync(target, text);
      log(`binance: could not write ${tmp} (${err.code ?? err.message}); wrote ${target} in place`);
      return target;
    } catch (err2) {
      log(`binance: COULD NOT WRITE ${target}: ${err2.code ?? err2.message}`);
      return null;
    }
  }
}

/** One line per HTTP request, fixed format, no query string. */
export function httpLine(nowMs, url, outcome, ms) {
  const u = new URL(url);
  return `http ${new Date(nowMs).toISOString()} ${u.host} ${u.pathname} ${outcome} ${Math.round(ms)}ms`;
}

/** fetch with the user agent set and one `http …` line logged. Used for every engine request. */
export function loggedFetch({ fetchImpl, now, userAgent, out }) {
  return async (url, init = {}) => {
    const headers = { ...(init.headers ?? {}), 'user-agent': userAgent };
    const t0 = performance.now();
    try {
      const res = await fetchImpl(url, { ...init, headers });
      out(httpLine(now(), url, res.status, performance.now() - t0));
      return res;
    } catch (err) {
      out(httpLine(now(), url, `error:${err?.name ?? 'Error'}`, performance.now() - t0));
      throw err;
    }
  };
}

export function createBinanceGate({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  userAgent,
  pauseDir = DEFAULT_PAUSE_DIR,
  limit = BUDGET,
  windowMs = WINDOW_MS,
  out = (s) => process.stdout.write(`${s}\n`),
  log = (s) => process.stderr.write(`${s}\n`),
} = {}) {
  const send = loggedFetch({ fetchImpl, now, userAgent, out });
  const sent = []; // times of requests in the current window
  let backoffUntil = 0;
  let backoffSec = 0;
  let banned = null;
  let lastNote = '';

  const note = (s) => {
    if (s !== lastNote && s) log(s);
    lastNote = s;
  };

  /** Why no request may go out right now, or null. */
  function closed() {
    const t = now();
    if (banned) return { why: banned, until: null, banned: true };
    const p = readPauses(pauseDir, t);
    if (p) return { why: `paused by ${p.file} until ${new Date(p.until).toISOString()}${p.reason ? ` (${p.reason})` : ''}`, until: p.until };
    if (backoffUntil > t) return { why: `backing off after 429 until ${new Date(backoffUntil).toISOString()}`, until: backoffUntil };
    return null;
  }

  function used() {
    const t = now();
    while (sent.length && sent[0] <= t - windowMs) sent.shift();
    return sent.length;
  }

  return {
    limit,
    get banned() { return banned; },

    /** How many requests may go out right now (0 when paused, backing off or banned). */
    available() {
      const c = closed();
      if (c) {
        note(`binance: ${c.why}; no requests`);
        return 0;
      }
      if (lastNote) note('binance: requests allowed again');
      lastNote = '';
      return Math.max(0, limit - used());
    },

    async fetch(url, init = {}) {
      const c = closed();
      if (c?.banned) throw new BannedError(c.why);
      if (c) throw new GateClosedError(`binance: ${c.why}`, c.until);
      if (used() >= limit) throw new GateClosedError(`binance: ${limit} requests in the last ${windowMs / 1000} s; waiting`);
      sent.push(now());
      const res = await send(url, init);
      if (res.status === 429) {
        const ra = retryAfterSec(res.headers?.get?.('retry-after'), now());
        backoffSec = ra ?? Math.min(backoffSec ? backoffSec * 2 : BACKOFF_FIRST_SEC, BACKOFF_MAX_SEC);
        backoffUntil = now() + backoffSec * 1000;
        throw new GateClosedError(`binance: 429, waiting ${backoffSec} s${ra != null ? ' (Retry-After)' : ''}`, backoffUntil);
      }
      if (res.status === 418 || res.status === 403) {
        const ra = retryAfterSec(res.headers?.get?.('retry-after'), now());
        const untilSec = Math.ceil(now() / 1000) + (ra ?? BAN_PAUSE_SEC);
        const file = writeOwnPause(pauseDir, untilSec, `${res.status} data-api`, log);
        banned = `Binance answered ${res.status}; stopped. Pause written to ${file ?? '(nothing: write failed)'} until ${new Date(untilSec * 1000).toISOString()}. A human must look before restarting.`;
        throw new BannedError(banned);
      }
      if (res.ok) backoffSec = 0;
      return res;
    },
  };
}
