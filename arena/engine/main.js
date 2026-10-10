#!/usr/bin/env node
// The arena engine's loop (runs on the server). Every `pollSec`:
//   1. add agents listed in the roster file;
//   2. pull new orders from the front door;
//   3. fetch 1-minute candles from Binance's public data API (no other exchange);
//   4. let the Arena settle every finished minute;
//   5. write its events to a signed ledger, then push a signed bundle back.
// It needs no exchange keys and opens no ports. Its only secret is its own
// signing key, created on first run; the public half goes into the Worker.
//
// Binance requests (see binance-gate.js): at most 12 in any rolling 60 s, all
// counted in one place. Steady state is one 1-minute request per symbol per
// minute (6/min with six symbols) plus one daily-candle request at 00:00 UTC.
// The market snapshot is built from those same 1-minute candles (hourly bars
// kept in state); 1-hour candles are fetched only to seed it (first start, or
// after a gap). Catch-up after downtime takes 300 minutes per step, a step only
// starts when the whole step fits in the budget, so it trickles at ≤ 12/min.
// On 418/403 the engine writes /var/lib/binance-guard/arena.pause, logs, and
// exits non-zero; the service is Restart=no, so it waits for a human.
//
//   node engine/main.js run  --config /etc/arena/config.json
//   node engine/main.js once --config …      (one round, for checks)
//   node engine/main.js pubkey --config …    (print the public key)

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BRAND } from '../../guard/src/brand.js';
import { canon } from '../../guard/src/canon.js';
import { writeJson } from '../../guard/src/config.js';
import { loadOrCreateKey, publicRaw, signText } from '../../guard/src/keys.js';
import { Ledger } from '../../guard/src/ledger.js';
import { createMarket } from '../../guard/src/market.js';
import { fmt, parse } from '../../guard/src/money.js';
import { BASELINES } from '../src/baselines.js';
import { Arena, MINUTE } from '../src/engine.js';
import { BannedError, createBinanceGate, DEFAULT_PAUSE_DIR, loggedFetch } from './binance-gate.js';

const SETTLE_LAG_MS = 20_000; // wait this long past a minute before settling it
const MAX_CANDLES = 300; // per request; a long gap is caught up over several rounds
const MAX_PENDING_EVENTS = 5000;
// Settling stuck on one minute (most likely Binance lacks that 1-minute candle for a symbol):
// log once after this much wall time, then again every STALL_LOG_EVERY_MS.
export const STALL_LOG_AFTER_MS = 5 * 60_000;
export const STALL_LOG_EVERY_MS = 30 * 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const VERSION = JSON.parse(readFileSync(new URL('../../guard/package.json', import.meta.url), 'utf8')).version;
export const USER_AGENT = `tal-arena/${VERSION}`;

export function loadEngineConfig(file) {
  const c = JSON.parse(readFileSync(file, 'utf8'));
  for (const k of ['api', 'home', 'roster', 'season']) if (!c[k]) throw new Error(`config: ${k} missing`);
  // Prices come from Binance's public data API only; the key stays for old configs.
  if (c.priceSource != null && c.priceSource !== 'binance') throw new Error('config: priceSource can only be "binance"');
  return {
    pollSec: 20,
    priceSource: 'binance',
    pauseDir: DEFAULT_PAUSE_DIR, // shared pause directory; the operator confirms the path
    source: `${BRAND.name} arena · paper trading at Binance spot prices`,
    ...c,
    season: { id: c.season.id, from: Date.parse(c.season.from), to: Date.parse(c.season.to) },
  };
}

export class EngineLoop {
  constructor({
    config, fetchImpl = globalThis.fetch, now = Date.now,
    log = (s) => process.stderr.write(`${s}\n`), out = (s) => process.stdout.write(`${s}\n`),
  }) {
    this.c = config;
    this.now = now;
    this.log = log;
    this.fetch = loggedFetch({ fetchImpl, now, userAgent: USER_AGENT, out }); // the front door
    this.gate = createBinanceGate({ fetchImpl, now, userAgent: USER_AGENT, pauseDir: config.pauseDir ?? DEFAULT_PAUSE_DIR, out, log });
    this.key = loadOrCreateKey(join(config.home, 'engine.key'));
    this.ledger = new Ledger({ dir: join(config.home, 'ledger'), agent: 'arena-engine', key: this.key });
    this.market = createMarket({ source: 'binance', fetchImpl: this.gate.fetch, now, userAgent: USER_AGENT, cacheMs: 0 });
    this.stateFile = join(config.home, 'state.json');
    this._load();
  }

  pubkey() {
    return publicRaw(this.key);
  }

  _load() {
    if (existsSync(this.stateFile)) {
      const j = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      this.arena = Arena.fromJSON(j.arena);
      this.s = { mkt: null, hours: {}, ...j.loop };
    } else {
      this.arena = new Arena({ season: this.c.season, rules: this.c.rules });
      for (const id of this.c.baselines ?? Object.keys(BASELINES)) this.arena.addBaseline(id, this.c.season.from);
      // mkt: newest 1-minute candle fetched; hours: hourly bars built from them, per symbol.
      this.s = { lastOrderId: 0, push: 0, pending: [], rosterSent: false, snapshot: null, mkt: null, hours: {} };
    }
  }

  _save() {
    writeJson(this.stateFile, { arena: this.arena.toJSON(), loop: this.s });
  }

  async _api(path, init) {
    const res = await this.fetch(`${this.c.api}${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${body.rule ?? ''} ${body.message ?? ''}`.trim());
    return body;
  }

  _record(events) {
    for (const e of events) {
      const { type, ...data } = e;
      const ev = this.ledger.append(type, data, this.now());
      const line = canon(ev); // byte for byte the line in the ledger file, so anyone can check the signature
      this.s.pending.push({ seq: ev.seq, agent: e.agent ?? null, day: ev.ts.slice(0, 10), line });
    }
    if (this.s.pending.length > MAX_PENDING_EVENTS) throw new Error('too many unsent events; is the front door down?');
  }

  _roster() {
    const list = JSON.parse(readFileSync(this.c.roster, 'utf8'));
    const added = [];
    for (const g of list) {
      if (this.arena.agents[g.agentId]) continue;
      const joined = g.joined ? Date.parse(g.joined) : Math.max(this.c.season.from, Math.ceil(this.now() / MINUTE) * MINUTE);
      try {
        this._record(this.arena.addAgent({ ...g, joined }));
        added.push(g.agentId);
      } catch (err) {
        this.log(`roster: ${g.agentId} not added: ${err.message}`);
      }
    }
    if (added.length) this.s.rosterSent = false;
    return added;
  }

  async _orders() {
    for (;;) {
      const { orders } = await this._api(`/orders?after=${this.s.lastOrderId}&limit=500`);
      for (const o of orders) {
        this._record(this.arena.receive({ line: o.line, recv: Date.parse(o.recv) }));
        this.s.lastOrderId = o.id;
      }
      if (orders.length < 500) return;
    }
  }

  /**
   * One step of 1-minute candles, if the whole step fits in the Binance budget.
   * In season: the minutes the Arena still has to settle (catch-up is 300 minutes a
   * step). Before the season: only the newest minutes, to keep the snapshot fresh.
   * After the season: nothing.
   */
  async _candles() {
    const a = this.arena;
    const target = Math.floor((this.now() - SETTLE_LAG_MS) / MINUTE) * MINUTE - MINUTE; // newest minute to take
    const seasonLast = a.season.to - MINUTE;
    const arenaFrom = a.minute == null ? Math.floor(a.season.from / MINUTE) * MINUTE : a.minute + MINUTE;
    let from;
    let to;
    let settle = false;
    if (arenaFrom <= seasonLast) {
      if (arenaFrom <= target) {
        from = arenaFrom;
        to = Math.min(target, seasonLast);
        settle = true;
      } else {
        from = Math.max(this.s.mkt == null ? target : this.s.mkt + MINUTE, target - (MAX_CANDLES - 1) * MINUTE);
        to = Math.min(target, arenaFrom - MINUTE);
      }
    }
    if (from == null || from > to) return null;
    const limit = Math.min((to - from) / MINUTE + 1, MAX_CANDLES);
    const last = from + (limit - 1) * MINUTE;
    // The 20-day moving-average baseline needs daily closes at each day start it settles.
    // A step is under a day long, so it holds at most one day start.
    const dayStart = Math.ceil(from / DAY) * DAY;
    const needDaily = settle && dayStart <= last;
    if (this.gate.available() < a.symbols.length + (needDaily ? 1 : 0)) return null; // wait for budget; never part of a step

    const book = { open: {}, close: {}, source: {} };
    let newest = Infinity;
    for (const s of a.symbols) {
      const { source, candles } = await this.market.candles(s, '1m', { startTime: from, limit });
      for (const k of candles) {
        book.open[`${s}@${k.t}`] = k.o;
        book.close[`${s}@${k.t}`] = k.c;
        book.source[`${s}@${k.t}`] = source;
      }
      this._foldHours(s, candles);
      newest = Math.min(newest, candles.length ? candles[candles.length - 1].t : -Infinity);
    }
    if (Number.isFinite(newest)) this.s.mkt = Math.max(this.s.mkt ?? newest, newest);
    const daily = {};
    if (needDaily) {
      try {
        const { candles } = await this.market.candles('BTCUSDT', '1d', { startTime: dayStart - 20 * DAY, limit: 20 });
        const got = candles.filter((k) => k.t < dayStart).map((k) => k.c);
        if (got.length === 20) daily[dayStart] = got;
      } catch (err) {
        if (err?.gate) throw err;
        /* no daily data: the baseline simply does nothing that day */
      }
    }
    if (!settle) return null;
    return {
      open: (s, m) => book.open[`${s}@${m}`],
      close: (s, m) => book.close[`${s}@${m}`],
      source: (s, m) => book.source[`${s}@${m}`],
      daily: (s, d) => (s === 'BTCUSDT' ? daily[d] : undefined),
    };
  }

  /** The 25 hourly bars a symbol's snapshot shows: its newest hour and the 24 before. */
  static hourRange(upto) {
    const cur = Math.floor(upto / HOUR) * HOUR;
    return { first: cur - 24 * HOUR, cur };
  }

  /** Add 1-minute candles to the symbol's hourly bars (each minute counted once). */
  _foldHours(symbol, candles) {
    const h = (this.s.hours[symbol] ??= { upto: -1, bars: {} });
    for (const k of candles) {
      if (k.t <= h.upto) continue;
      const t = Math.floor(k.t / HOUR) * HOUR;
      const b = h.bars[t];
      if (!b) h.bars[t] = { o: k.o, h: k.h, l: k.l, c: k.c, v: fmt(parse(k.v)) };
      else {
        if (parse(k.h) > parse(b.h)) b.h = k.h;
        if (parse(k.l) < parse(b.l)) b.l = k.l;
        b.c = k.c;
        b.v = fmt(parse(b.v) + parse(k.v));
      }
      h.upto = k.t;
    }
    const { first } = EngineLoop.hourRange(h.upto);
    for (const t of Object.keys(h.bars)) if (Number(t) < first) delete h.bars[t];
  }

  _hoursComplete(symbol) {
    const h = this.s.hours[symbol];
    if (!h || h.upto < 0) return false;
    const { first, cur } = EngineLoop.hourRange(h.upto);
    for (let t = first; t <= cur; t += HOUR) if (!h.bars[t]) return false;
    return true;
  }

  /**
   * The public market snapshot, from the hourly bars. A symbol missing hours (first
   * start, or a gap) is seeded with one 1-hour request, only from leftover budget.
   */
  async _snapshot() {
    for (const s of this.arena.symbols) {
      if (this._hoursComplete(s)) continue;
      if (this.gate.available() < 1) break;
      const { candles } = await this.market.candles(s, '1h', { limit: 25 });
      const bars = {};
      for (const k of candles) bars[k.t] = { o: k.o, h: k.h, l: k.l, c: k.c, v: k.v };
      // The newest 1-hour candle already holds trades up to now, so minutes up to now
      // are not added again; later 1-minute candles add on top.
      this.s.hours[s] = { upto: Math.floor(this.now() / MINUTE) * MINUTE, bars };
    }
    if (!this.arena.symbols.every((s) => this._hoursComplete(s))) return null;
    const markets = {};
    for (const s of this.arena.symbols) {
      const { first, cur } = EngineLoop.hourRange(this.s.hours[s].upto);
      const rows = [];
      for (let t = first; t <= cur; t += HOUR) rows.push([t, this.s.hours[s].bars[t]]);
      const [, firstBar] = rows[0];
      const [, lastBar] = rows[rows.length - 1];
      markets[s] = {
        price: lastBar.c,
        change24hPct: Number((((Number(lastBar.c) - Number(firstBar.o)) / Number(firstBar.o)) * 100).toFixed(2)),
        candles1h: rows.slice(-24).map(([t, k]) => [new Date(t).toISOString(), k.o, k.h, k.l, k.c, k.v]),
        source: 'binance',
      };
    }
    this.s.snapshot = {
      asOf: new Date(this.now()).toISOString(),
      note: 'Public market data, for agents deciding what to do. Fills use the next 1-minute open, not these prices.',
      candleFormat: ['open_time', 'open', 'high', 'low', 'close', 'volume'],
      markets,
    };
    return this.s.snapshot;
  }

  /**
   * How far the season is settled: the end of the last settled minute, which is also the
   * open time of the next minute to settle (same as the live board's asOf). ISO string;
   * null before the season starts and once it has closed.
   */
  settledTo() {
    const a = this.arena;
    if (a.seasonClosed || this.now() < a.season.from) return null;
    return new Date(a.minute == null ? Math.floor(a.season.from / MINUTE) * MINUTE : a.minute + MINUTE).toISOString();
  }

  /** One log line when settling has been stuck on the same minute for a while (then every 30 min). */
  _watchStall(candles) {
    const to = this.settledTo();
    const now = this.now();
    if (to == null) {
      this._stall = null;
      return;
    }
    if (this._stall?.to !== to) this._stall = { to, since: now, next: now + STALL_LOG_AFTER_MS, missing: null };
    const m = Date.parse(to);
    if (candles) this._stall.missing = this.arena.symbols.filter((s) => candles.open(s, m) === undefined || candles.close(s, m) === undefined);
    if (now <= this._stall.next) return;
    this._stall.next = now + STALL_LOG_EVERY_MS;
    const { missing } = this._stall;
    const why = missing == null ? 'no candles fetched yet (Binance budget or pause)'
      : missing.length ? `no 1-minute candle from Binance for ${missing.join(', ')}` : 'candles are there; check the engine';
    this.log(`settling stuck at ${to} for ${Math.floor((now - this._stall.since) / MINUTE)} min: ${why}`);
  }

  _bundle() {
    const a = this.arena;
    const blobs = { 'standings/latest': a.standings('week', { source: this.c.source }) };
    for (const id of Object.keys(a.agents)) blobs[`accounts/${id}`] = a.accountView(id, this.now());
    if (this.s.snapshot) blobs.snapshot = this.s.snapshot;
    for (const c of a.closed) {
      blobs[`${c.kind === 'week' ? 'weekly' : 'season'}/${c.id}`] = a.standings(c.kind, { source: this.c.source, closed: c });
    }
    const body = {
      ts: new Date(this.now()).toISOString(),
      // A clock-based number that only goes up, so a retry after a lost reply is never "stale".
      push: Math.max(this.s.push + 1, this.now()),
      settledTo: this.settledTo(), // for the Worker's /health only; not published as data
      events: this.s.pending,
      blobs,
    };
    if (!this.s.rosterSent) {
      body.agents = Object.values(a.agents).map((g) => ({
        agentId: g.agentId, name: g.name, model: g.model, official: g.official,
        pubkey: g.pubkey ?? "", joined: new Date(g.joined).toISOString(), status: g.status,
      }));
    }
    return body;
  }

  /** One round. Returns a short summary for the log. */
  async once() {
    if (this.gate.banned) throw new BannedError(this.gate.banned); // this process never asks Binance again
    const added = this._roster();
    await this._orders();
    let candles = null;
    try {
      candles = await this._candles();
    } catch (err) {
      if (err instanceof BannedError || !err?.gate) throw err;
      this.log(err.message); // budget, pause or 429: no settling this round, the rest goes on
    }
    const before = this.arena.minute;
    if (candles) this._record(this.arena.advance(this.now() - SETTLE_LAG_MS, candles));
    this._watchStall(candles);
    try {
      await this._snapshot();
    } catch (err) {
      if (err instanceof BannedError) throw err;
      this.log(`snapshot: ${err.message}`);
    }
    const body = JSON.stringify(this._bundle());
    await this._api('/engine', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body, sig: signText(this.key, body) }) });
    const sent = this.s.pending.length;
    this.s.push = JSON.parse(body).push;
    this.s.pending = [];
    this.s.rosterSent = true;
    this.arena.closed = [];
    this._save();
    return { added, minutes: this.arena.minute == null || before == null ? 0 : (this.arena.minute - before) / MINUTE, events: sent };
  }

  async run() {
    this.log(`arena engine up · season ${this.c.season.id} · key ${this.pubkey()}`);
    for (;;) {
      try {
        const r = await this.once();
        if (r.added.length || r.events) this.log(`round: +${r.added.length} agents, ${r.minutes} min, ${r.events} events`);
      } catch (err) {
        this._save();
        if (err instanceof BannedError) {
          this.log(`STOPPED: ${err.message}`);
          throw err; // exit non-zero; the service does not restart itself
        }
        this.log(`round failed: ${err.message}`);
      }
      await new Promise((res) => setTimeout(res, this.c.pollSec * 1000));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, , file] = process.argv.slice(2);
  const config = loadEngineConfig(file ?? process.env.ARENA_CONFIG);
  const loop = new EngineLoop({ config });
  if (cmd === 'pubkey') console.log(loop.pubkey());
  else if (cmd === 'once') console.log(JSON.stringify(await loop.once()));
  else if (cmd === 'run') {
    try {
      await loop.run();
    } catch (err) {
      console.error(`arena engine exiting: ${err.message}`);
      process.exit(err instanceof BannedError ? 3 : 1);
    }
  } else console.error('usage: main.js run|once|pubkey --config FILE');
}
