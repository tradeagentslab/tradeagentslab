#!/usr/bin/env node
// The arena engine's loop (runs on the server). Every `pollSec`:
//   1. add agents listed in the roster file;
//   2. pull new orders from the front door;
//   3. fetch 1-minute candles (Binance spot, OKX if Binance cannot be reached);
//   4. let the Arena settle every finished minute;
//   5. write its events to a signed ledger, then push a signed bundle back.
// It needs no exchange keys and opens no ports. Its only secret is its own
// signing key, created on first run; the public half goes into the Worker.
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
import { BASELINES } from '../src/baselines.js';
import { Arena, MINUTE } from '../src/engine.js';

const SETTLE_LAG_MS = 20_000; // wait this long past a minute before settling it
const MAX_CANDLES = 300; // per request; a long gap is caught up over several rounds
const SNAPSHOT_EVERY_MS = 5 * MINUTE;
const MAX_PENDING_EVENTS = 5000;

export function loadEngineConfig(file) {
  const c = JSON.parse(readFileSync(file, 'utf8'));
  for (const k of ['api', 'home', 'roster', 'season']) if (!c[k]) throw new Error(`config: ${k} missing`);
  return {
    pollSec: 20,
    priceSource: 'binance',
    source: `${BRAND.name} arena · paper trading at Binance spot prices`,
    ...c,
    season: { id: c.season.id, from: Date.parse(c.season.from), to: Date.parse(c.season.to) },
  };
}

export class EngineLoop {
  constructor({ config, fetchImpl = globalThis.fetch, now = Date.now, log = (s) => process.stderr.write(`${s}\n`) }) {
    this.c = config;
    this.fetch = fetchImpl;
    this.now = now;
    this.log = log;
    this.key = loadOrCreateKey(join(config.home, 'engine.key'));
    this.ledger = new Ledger({ dir: join(config.home, 'ledger'), agent: 'arena-engine', key: this.key });
    this.market = createMarket({ source: config.priceSource, fetchImpl, now, userAgent: `${BRAND.mcpName}-arena`, cacheMs: 0 });
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
      this.s = j.loop;
    } else {
      this.arena = new Arena({ season: this.c.season, rules: this.c.rules });
      for (const id of this.c.baselines ?? Object.keys(BASELINES)) this.arena.addBaseline(id, this.c.season.from);
      this.s = { lastOrderId: 0, push: 0, pending: [], rosterSent: false, snapshotAt: 0, snapshot: null };
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

  async _candles() {
    const a = this.arena;
    const from = a.minute == null ? Math.floor(a.season.from / MINUTE) * MINUTE : a.minute + MINUTE;
    const to = Math.min(Math.floor((this.now() - SETTLE_LAG_MS) / MINUTE) * MINUTE - MINUTE, a.season.to - MINUTE);
    const book = { open: {}, close: {}, source: {} };
    if (from > to) return null;
    const limit = Math.min((to - from) / MINUTE + 1, MAX_CANDLES);
    for (const s of a.symbols) {
      const { source, candles } = await this.market.candles(s, '1m', { startTime: from, limit });
      for (const k of candles) {
        book.open[`${s}@${k.t}`] = k.o;
        book.close[`${s}@${k.t}`] = k.c;
        book.source[`${s}@${k.t}`] = source;
      }
    }
    // Daily closes for the moving-average baseline: the 20 full days before each day start in range.
    const DAY = 86_400_000;
    const daily = {};
    for (let d = Math.ceil(from / DAY) * DAY; d <= to; d += DAY) {
      try {
        const { candles } = await this.market.candles('BTCUSDT', '1d', { startTime: d - 20 * DAY, limit: 20 });
        const got = candles.filter((k) => k.t < d).map((k) => k.c);
        if (got.length === 20) daily[d] = got;
      } catch { /* no daily data: the baseline simply does nothing that day */ }
    }
    return {
      open: (s, m) => book.open[`${s}@${m}`],
      close: (s, m) => book.close[`${s}@${m}`],
      source: (s, m) => book.source[`${s}@${m}`],
      daily: (s, dayStart) => (s === 'BTCUSDT' ? daily[dayStart] : undefined),
    };
  }

  async _snapshot() {
    if (this.s.snapshot && this.now() - this.s.snapshotAt < SNAPSHOT_EVERY_MS) return null;
    const markets = {};
    for (const s of this.arena.symbols) {
      const { source, candles } = await this.market.candles(s, '1h', { limit: 25 });
      const last = candles[candles.length - 1];
      const first = candles[0];
      markets[s] = {
        price: last.c,
        change24hPct: Number((((Number(last.c) - Number(first.o)) / Number(first.o)) * 100).toFixed(2)),
        candles1h: candles.slice(-24).map((k) => [new Date(k.t).toISOString(), k.o, k.h, k.l, k.c, k.v]),
        source,
      };
    }
    this.s.snapshot = {
      asOf: new Date(this.now()).toISOString(),
      note: 'Public market data, for agents deciding what to do. Fills use the next 1-minute open, not these prices.',
      candleFormat: ['open_time', 'open', 'high', 'low', 'close', 'volume'],
      markets,
    };
    this.s.snapshotAt = this.now();
    return this.s.snapshot;
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
    const added = this._roster();
    await this._orders();
    const candles = await this._candles();
    const before = this.arena.minute;
    if (candles) this._record(this.arena.advance(this.now() - SETTLE_LAG_MS, candles));
    try { await this._snapshot(); } catch (err) { this.log(`snapshot: ${err.message}`); }
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
  else if (cmd === 'run') await loop.run();
  else console.error('usage: main.js run|once|pubkey --config FILE');
}
