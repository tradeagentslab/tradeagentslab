// The guard itself: every button the agent (or a person) presses goes through here.
// Each call takes the lock, loads the account, settles due fills, does one thing,
// writes the ledger and saves. The ledger is the truth; state.json is a cache that
// is rebuilt from the ledger whenever the two disagree.

import { existsSync, readFileSync, unlinkSync } from 'node:fs';

import { applyFill, buyAt, buyReserve, equity as bookEquity, newBook, sellAt } from './book.js';
import { configHash, limitsForLedger, loadConfig, pathsFor, saveConfig, withLock, writeJson } from './config.js';
import { loadOrCreateKey, publicRaw } from './keys.js';
import { Ledger } from './ledger.js';
import { INTERVALS, nextMinute } from './market.js';
import { div, fmt, parse, show } from './money.js';
import { check, DEFAULT_LIMITS, SYMBOL_RE } from './rules.js';

const FILL_DELAY_MS = 2000; // fill this long after the candle opens, so it surely exists
const REJECT_LOOP = 30; // this many rejected orders within an hour halts the guard
const REASON_MAX = 280;
const JOURNAL_MAX = 500;
const HOUR = 3600_000;
const KEEP_MS = 48 * HOUR;

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayStartMs = (ms) => Date.parse(`${utcDay(ms)}T00:00:00Z`);
const iso = (ms) => new Date(ms).toISOString();
const pct = (part, whole) => (whole === 0n ? '0' : (Number((part * 10000n) / whole) / 100).toFixed(2));

export const PRICING = 'Market orders fill at the open of the next 1-minute candle '
  + '(Binance spot public data). Fee 0.1% per side. '
  + 'Spot only: no leverage, no shorting, no limit orders in v0.';

export class GuardError extends Error {}

/** Clean up what an agent typed: "btc", "BTC/USDT" and "btcusdt" all mean BTCUSDT. */
export function normalizeSymbol(raw) {
  const s = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.endsWith('USDT') ? s : `${s}USDT`;
}

/** Prices and candles for the market tool (shared by paper and arena mode). */
export async function marketView(market, cfg, { symbols, interval = '1h', limit = 24 } = {}, now = Date.now()) {
  const list = (symbols?.length ? symbols : cfg.symbols).map(normalizeSymbol);
  if (!INTERVALS[interval]) throw new GuardError(`interval must be one of ${Object.keys(INTERVALS).join(', ')}`);
  const n = Math.min(Math.max(Number(limit) || 24, 1), 100);
  const out = [];
  for (const sym of list) {
    if (!SYMBOL_RE.test(sym)) throw new GuardError(`bad symbol: ${sym}`);
    const { source, candles } = await market.candles(sym, interval, { limit: n });
    const last = candles[candles.length - 1];
    const first = candles[0];
    out.push({
      symbol: sym,
      tradable: cfg.symbols.includes(sym),
      price: show(parse(last.c), 8),
      change_pct: pct(parse(last.c) - parse(first.o), parse(first.o)),
      window: `${n} × ${interval}`,
      candles: candles.map((k) => [iso(k.t), k.o, k.h, k.l, k.c, k.v]),
      source,
    });
  }
  return { as_of: iso(now), candle_format: ['open_time', 'open', 'high', 'low', 'close', 'volume'], markets: out };
}

function fresh(startCash, cfgHash) {
  return {
    seq: -1,
    cfgHash,
    startCash,
    book: newBook(startCash),
    pending: [],
    accepted: [],
    rejected: [],
    day: null,
    halted: null,
  };
}

/** Rebuild the account from ledger events. */
export function replay(events) {
  let s = null;
  for (const ev of events) {
    const d = ev.data;
    const t = Date.parse(ev.ts);
    if (ev.type === 'init') s = fresh(parse(d.start_cash), d.cfg_hash);
    if (!s) throw new GuardError('ledger does not start with init');
    switch (ev.type) {
      case 'order':
        if (d.verdict === 'accepted') {
          s.pending.push({
            id: d.id, symbol: d.symbol, side: d.side,
            quote: d.usdt != null ? parse(d.usdt) : undefined,
            qty: d.qty != null ? parse(d.qty) : undefined,
            ts: t, fillAt: Date.parse(d.fill_at), flatten: Boolean(d.flatten),
          });
          if (!d.flatten) s.accepted.push(t);
        } else {
          s.rejected.push(t);
        }
        break;
      case 'fill':
        s.pending = s.pending.filter((o) => o.id !== d.id);
        applyFill(s.book, { side: d.side, symbol: d.symbol, qty: parse(d.qty), notional: parse(d.notional), fee: parse(d.fee) });
        break;
      case 'cancel':
        s.pending = s.pending.filter((o) => o.id !== d.id);
        break;
      case 'halt':
        s.halted = { by: d.by, reason: d.reason, ts: ev.ts };
        break;
      case 'resume':
        s.halted = null;
        break;
      case 'day':
        s.day = { date: d.date, startEquity: parse(d.start_equity) };
        break;
      case 'config':
        s.cfgHash = d.cfg_hash;
        break;
      default:
        break;
    }
    s.seq = ev.seq;
  }
  return s;
}

function serialize(s) {
  return {
    v: 1,
    seq: s.seq,
    cfgHash: s.cfgHash,
    startCash: fmt(s.startCash),
    cash: fmt(s.book.cash),
    pos: Object.fromEntries(Object.entries(s.book.pos).map(([k, v]) => [k, fmt(v)])),
    pending: s.pending.map((o) => ({ ...o, quote: o.quote != null ? fmt(o.quote) : undefined, qty: o.qty != null ? fmt(o.qty) : undefined })),
    accepted: s.accepted,
    rejected: s.rejected,
    day: s.day ? { date: s.day.date, startEquity: fmt(s.day.startEquity) } : null,
    halted: s.halted,
  };
}

function deserialize(j) {
  return {
    seq: j.seq,
    cfgHash: j.cfgHash,
    startCash: parse(j.startCash),
    book: { cash: parse(j.cash), pos: Object.fromEntries(Object.entries(j.pos).map(([k, v]) => [k, parse(v)])) },
    pending: j.pending.map((o) => ({ ...o, quote: o.quote != null ? parse(o.quote) : undefined, qty: o.qty != null ? parse(o.qty) : undefined })),
    accepted: j.accepted,
    rejected: j.rejected,
    day: j.day ? { date: j.day.date, startEquity: parse(j.day.startEquity) } : null,
    halted: j.halted,
  };
}

export class Guard {
  /**
   * root: the guard's home folder. market: from createMarket(). now: clock (tests).
   * agent: override the agent named in the config.
   */
  constructor({ root, market, now = Date.now, agent } = {}) {
    this.root = root;
    this.market = market;
    this.now = now;
    this.agent = agent;
  }

  // ---------- plumbing ----------

  async _op(fn) {
    const cfg = loadConfig(this.root);
    const agent = this.agent ?? cfg.agent;
    const p = pathsFor(this.root, agent);
    return withLock(p.lock, async () => {
      const key = loadOrCreateKey(p.key);
      const ledger = new Ledger({ dir: p.ledger, agent, key });
      const ctx = { cfg, p, ledger, key, agent, s: this._load(cfg, p, ledger, key) };
      try {
        await this._tick(ctx);
        return await fn(ctx);
      } finally {
        writeJson(p.state, serialize(ctx.s));
      }
    });
  }

  _load(cfg, p, ledger, key) {
    const head = ledger.head();
    if (head.seq === -1) {
      const s = fresh(parse(String(cfg.start_cash)), configHash(cfg));
      ledger.append('init', {
        start_cash: fmt(s.startCash),
        venue: cfg.venue,
        symbols: cfg.symbols,
        limits: limitsForLedger(cfg.limits),
        cfg_hash: s.cfgHash,
        pubkey: publicRaw(key),
        pricing: PRICING,
      }, this.now());
      s.seq = 0;
      return s;
    }
    if (existsSync(p.state)) {
      try {
        const s = deserialize(JSON.parse(readFileSync(p.state, 'utf8')));
        if (s.seq === head.seq) return s;
      } catch { /* rebuild below */ }
    }
    return replay(ledger.events());
  }

  _append(ctx, type, data) {
    const ev = ctx.ledger.append(type, data, this.now());
    ctx.s.seq = ev.seq;
    return ev;
  }

  _halt(ctx, by, reason) {
    const { s } = ctx;
    for (const o of s.pending.filter((x) => !x.flatten)) {
      this._append(ctx, 'cancel', { id: o.id, why: 'halt' });
    }
    s.pending = s.pending.filter((x) => x.flatten);
    s.halted = { by, reason, ts: iso(this.now()) };
    this._append(ctx, 'halt', { by, reason });
  }

  async _prices(symbols) {
    if (!symbols.length) return { prices: {}, priceTime: {}, raw: {} };
    const raw = await this.market.latest(symbols);
    const prices = {};
    const priceTime = {};
    for (const [k, v] of Object.entries(raw)) {
      prices[k] = parse(v.price);
      priceTime[k] = v.time;
    }
    return { prices, priceTime, raw };
  }

  async _equityNow(ctx, extra = []) {
    const held = Object.keys(ctx.s.book.pos);
    const symbols = [...new Set([...held, ...extra])];
    const px = await this._prices(symbols);
    return { ...px, equity: bookEquity(ctx.s.book, px.prices) };
  }

  /** Settle what is due: HALT file, config edits, fills, the day's start, the loss breaker. */
  async _tick(ctx) {
    const { s, cfg, p } = ctx;
    const now = this.now();

    if (existsSync(p.halt) && !s.halted) this._halt(ctx, 'human', 'HALT file');
    if (configHash(cfg) !== s.cfgHash && !s.halted) this._halt(ctx, 'guard', 'config_changed');

    for (const o of [...s.pending].sort((a, b) => a.fillAt - b.fillAt)) {
      if (now < o.fillAt + FILL_DELAY_MS) continue;
      let px;
      try {
        px = await this.market.openAt(o.symbol, o.fillAt);
      } catch {
        px = null;
      }
      if (!px) continue;
      const price = parse(px.price);
      const f = o.side === 'buy' ? buyAt(o.quote, price) : sellAt(o.qty, price);
      try {
        applyFill(s.book, { ...f, side: o.side, symbol: o.symbol });
      } catch (err) {
        s.pending = s.pending.filter((x) => x.id !== o.id);
        this._append(ctx, 'cancel', { id: o.id, why: `cannot fill: ${err.message}` });
        continue;
      }
      s.pending = s.pending.filter((x) => x.id !== o.id);
      this._append(ctx, 'fill', {
        id: o.id, symbol: o.symbol, side: o.side,
        qty: fmt(f.qty), price: fmt(price), notional: fmt(f.notional), fee: fmt(f.fee),
        cash: fmt(s.book.cash), candle: iso(o.fillAt), source: px.source,
      });
    }

    const today = utcDay(now);
    if (s.day?.date !== today) {
      const t0 = dayStartMs(now);
      const prices = {};
      let ok = true;
      for (const sym of Object.keys(s.book.pos)) {
        let px = null;
        try { px = await this.market.openAt(sym, t0); } catch { /* try later */ }
        if (!px) { ok = false; break; }
        prices[sym] = px.price;
      }
      if (ok) {
        const eq = bookEquity(s.book, Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, parse(v)])));
        s.day = { date: today, startEquity: eq };
        this._append(ctx, 'day', { date: today, start_equity: fmt(eq), prices });
      }
    }

    if (!s.halted) {
      let eq = s.book.cash;
      if (Object.keys(s.book.pos).length) {
        try { eq = (await this._equityNow(ctx)).equity; } catch { eq = null; }
      }
      if (eq != null && eq * 10000n <= s.startCash * (10000n - BigInt(Math.round(cfg.limits.max_loss_pct * 100)))) {
        this._halt(ctx, 'guard', 'max_loss');
      }
    }

    s.accepted = s.accepted.filter((t) => now - t < KEEP_MS);
    s.rejected = s.rejected.filter((t) => now - t < KEEP_MS);
  }

  _reservations(s) {
    let reservedCash = 0n;
    const reservedQty = {};
    const pendingBuy = {};
    for (const o of s.pending) {
      if (o.side === 'buy') {
        reservedCash += buyReserve(o.quote);
        pendingBuy[o.symbol] = (pendingBuy[o.symbol] ?? 0n) + o.quote;
      } else {
        reservedQty[o.symbol] = (reservedQty[o.symbol] ?? 0n) + o.qty;
      }
    }
    return { reservedCash, reservedQty, pendingBuy };
  }

  // ---------- buttons ----------

  /** Prices and candles. symbols defaults to the whitelist. */
  async marketData(args = {}) {
    return this._op(async ({ cfg }) => marketView(this.market, cfg, args, this.now()));
  }

  async account() {
    return this._op(async (ctx) => this._accountView(ctx, await this._equityNow(ctx)));
  }

  _accountView(ctx, px) {
    const { s, cfg, agent } = ctx;
    const { reservedCash } = this._reservations(s);
    const now = this.now();
    const eq = px.equity;
    const positions = Object.entries(s.book.pos).map(([sym, qty]) => {
      const value = (qty * px.prices[sym]) / 10n ** 8n;
      return {
        symbol: sym, qty: show(qty, 8), price: show(px.prices[sym], 8), value_usdt: show(value),
        pct_of_equity: eq ? pct(value, eq) : null,
      };
    });
    const lastHour = s.accepted.filter((t) => now - t < HOUR).length;
    const today = s.accepted.filter((t) => utcDay(t) === utcDay(now)).length;
    const L = cfg.limits;
    const dayLocked = s.day && eq != null
      && eq * 10000n <= s.day.startEquity * (10000n - BigInt(Math.round(L.daily_loss_pct * 100)));
    return {
      agent,
      venue: cfg.venue,
      halted: s.halted ?? false,
      cash_usdt: show(s.book.cash),
      free_cash_usdt: show(s.book.cash - reservedCash),
      equity_usdt: eq == null ? null : show(eq),
      start_usdt: show(s.startCash),
      pnl_pct: eq == null ? null : pct(eq - s.startCash, s.startCash),
      today: s.day && eq != null ? {
        start_equity_usdt: show(s.day.startEquity),
        pnl_pct: pct(eq - s.day.startEquity, s.day.startEquity),
        buys_allowed: !dayLocked && !s.halted,
      } : null,
      positions,
      pending_orders: s.pending.map((o) => ({
        id: o.id, symbol: o.symbol, side: o.side,
        ...(o.quote != null ? { usdt: show(o.quote) } : { qty: show(o.qty, 8) }),
        fills_at: iso(o.fillAt),
      })),
      orders_left: { this_hour: Math.max(L.max_orders_per_hour - lastHour, 0), today: Math.max(L.max_orders_per_day - today, 0) },
      max_order_usdt_now: eq == null ? null : show((eq * BigInt(Math.round(L.max_order_pct * 100))) / 10000n),
    };
  }

  /** The one button that trades. args: { symbol, side, usdt?, qty?, reason }. */
  async placeOrder(args = {}, by = 'agent') {
    return this._op(async (ctx) => {
      const { s, cfg } = ctx;
      const now = this.now();
      const symbol = normalizeSymbol(args.symbol);
      const side = String(args.side ?? '').toLowerCase();
      const reason = String(args.reason ?? '').trim();
      const base = { symbol, side, reason: reason.slice(0, REASON_MAX), by };

      const reject = (rule, message, extra = {}) => {
        this._append(ctx, 'order', { ...base, ...extra, verdict: 'rejected', rule, message });
        s.rejected.push(now);
        if (rule === 'max_loss' && !s.halted) this._halt(ctx, 'guard', 'max_loss');
        if (!s.halted && s.rejected.filter((t) => now - t < HOUR).length >= REJECT_LOOP) {
          this._halt(ctx, 'guard', 'rejection_loop');
        }
        return { status: 'rejected', rule, message };
      };

      if (!reason) return reject('bad_input', 'A reason is required: one or two sentences on why.');
      if (reason.length > REASON_MAX) return reject('bad_input', `Keep the reason under ${REASON_MAX} characters.`);

      let px;
      try {
        px = await this._equityNow(ctx, cfg.symbols.includes(symbol) ? [symbol] : []);
      } catch (err) {
        throw new GuardError(`market data unavailable: ${err.message}`);
      }

      const order = { symbol, side };
      let amount = {};
      try {
        if (side === 'buy') {
          if (args.usdt == null) return reject('bad_input', 'Buy needs usdt: how many USDT to spend.');
          order.quote = parse(typeof args.usdt === 'number' ? args.usdt : String(args.usdt));
          amount = { usdt: fmt(order.quote) };
        } else if (side === 'sell') {
          const { reservedQty } = this._reservations(s);
          const free = (s.book.pos[symbol] ?? 0n) - (reservedQty[symbol] ?? 0n);
          if (args.qty === 'all') order.qty = free;
          else if (args.qty != null) order.qty = parse(typeof args.qty === 'number' ? args.qty : String(args.qty));
          else if (args.usdt != null && px.prices[symbol]) {
            const want = div(parse(typeof args.usdt === 'number' ? args.usdt : String(args.usdt)), px.prices[symbol]);
            order.qty = want > free ? free : want;
          } else return reject('bad_input', 'Sell needs qty (or "all"), or usdt.');
          amount = { qty: fmt(order.qty) };
        }
      } catch {
        return reject('bad_input', 'Amounts must be plain numbers like 100 or 0.0015.');
      }

      const verdict = check(order, {
        halted: s.halted,
        symbols: cfg.symbols,
        limits: cfg.limits,
        cash: s.book.cash,
        ...this._reservations(s),
        pos: s.book.pos,
        prices: px.prices,
        priceTime: px.priceTime,
        equity: px.equity,
        dayStartEquity: s.day?.startEquity ?? null,
        startCash: s.startCash,
        acceptedTimes: s.accepted,
        now,
      });
      if (!verdict.ok) return reject(verdict.rule, verdict.message, amount);

      const fillAt = nextMinute(now);
      const id = `o${s.seq + 1}`;
      this._append(ctx, 'order', { ...base, ...amount, id, verdict: 'accepted', fill_at: iso(fillAt) });
      s.pending.push({ id, symbol, side, quote: order.quote, qty: order.qty, ts: now, fillAt, flatten: false });
      s.accepted.push(now);
      return {
        status: 'accepted',
        id,
        fills_at: iso(fillAt),
        note: `Fills at the open of the ${iso(fillAt).slice(11, 16)} UTC candle, about ${Math.round((fillAt + FILL_DELAY_MS - now) / 1000)} s from now. Check with fills or account.`,
      };
    });
  }

  /** Cancel one pending order by id, or all of them with id "all". */
  async cancelOrder({ id } = {}) {
    return this._op(async (ctx) => {
      const { s } = ctx;
      const targets = s.pending.filter((o) => !o.flatten && (id === 'all' || o.id === id));
      if (!targets.length) return { status: 'nothing_to_cancel', pending: s.pending.map((o) => o.id) };
      for (const o of targets) this._append(ctx, 'cancel', { id: o.id, why: 'asked' });
      s.pending = s.pending.filter((o) => !targets.includes(o));
      return { status: 'canceled', ids: targets.map((o) => o.id) };
    });
  }

  /** The most recent fills, newest first. */
  async fills({ limit = 10 } = {}) {
    return this._op(async (ctx) => {
      const n = Math.min(Math.max(Number(limit) || 10, 1), 100);
      const all = [];
      for (const ev of ctx.ledger.events()) if (ev.type === 'fill') all.push(ev.data);
      return {
        fills: all.slice(-n).reverse().map((d) => ({
          id: d.id, time: d.candle, symbol: d.symbol, side: d.side,
          qty: show(parse(d.qty), 8), price: show(parse(d.price), 8),
          usdt: show(parse(d.notional)), fee_usdt: show(parse(d.fee), 4),
        })),
      };
    });
  }

  async rules() {
    return this._op(async ({ cfg, s }) => ({
      venue: cfg.venue,
      start_usdt: show(s.startCash),
      symbols: cfg.symbols,
      limits: cfg.limits,
      pricing: PRICING,
      halt: 'You may call halt if something looks wrong. Only a person can resume.',
      halted: s.halted ?? false,
    }));
  }

  /** Stop trading. Agents can halt; only people resume. flatten: sell everything at the next open. */
  async halt({ reason } = {}, by = 'agent', { flatten = false } = {}) {
    return this._op(async (ctx) => {
      const { s } = ctx;
      const why = String(reason ?? '').trim().slice(0, REASON_MAX) || 'no reason given';
      if (!s.halted) this._halt(ctx, by, why);
      const sells = [];
      if (flatten && by === 'human') {
        const { reservedQty } = this._reservations(s);
        const now = this.now();
        for (const [symbol, qty] of Object.entries(s.book.pos)) {
          const free = qty - (reservedQty[symbol] ?? 0n);
          if (free <= 0n) continue;
          const fillAt = nextMinute(now);
          const id = `o${s.seq + 1}`;
          this._append(ctx, 'order', {
            id, symbol, side: 'sell', qty: fmt(free), reason: 'flatten on halt', by,
            verdict: 'accepted', fill_at: iso(fillAt), flatten: true,
          });
          s.pending.push({ id, symbol, side: 'sell', qty: free, ts: now, fillAt, flatten: true });
          sells.push(id);
        }
      }
      return { status: 'halted', halted: s.halted, flatten_orders: sells };
    });
  }

  /** People only (the CLI asks for a typed confirmation first). */
  async resume() {
    return this._op(async (ctx) => {
      const { s, cfg, p } = ctx;
      if (existsSync(p.halt)) unlinkSync(p.halt);
      if (!s.halted) return { status: 'not_halted' };
      const h = configHash(cfg);
      if (h !== s.cfgHash) {
        this._append(ctx, 'config', { cfg_hash: h, venue: cfg.venue, symbols: cfg.symbols, limits: limitsForLedger(cfg.limits) });
        s.cfgHash = h;
      }
      this._append(ctx, 'resume', { by: 'human' });
      s.halted = null;
      return { status: 'resumed' };
    });
  }

  /** One line for the record: what the agent saw, thought or learned. */
  async journal({ text } = {}) {
    return this._op(async (ctx) => {
      const t = String(text ?? '').trim();
      if (!t) throw new GuardError('journal needs text');
      const ev = this._append(ctx, 'journal', { text: t.slice(0, JOURNAL_MAX) });
      return { status: 'saved', seq: ev.seq };
    });
  }

  /** People only: change limits or the symbol list. The ledger records the change. */
  async setConfig(changes = {}) {
    return this._op(async (ctx) => {
      const { cfg, s } = ctx;
      const next = { ...cfg, limits: { ...cfg.limits } };
      for (const [k, v] of Object.entries(changes)) {
        if (k === 'symbols') next.symbols = String(v).split(',').map((x) => normalizeSymbol(x.trim())).filter(Boolean);
        else if (k in DEFAULT_LIMITS) next.limits[k] = Number(v);
        else throw new GuardError(`unknown setting: ${k}`);
      }
      saveConfig(this.root, next);
      const h = configHash(next);
      this._append(ctx, 'config', { cfg_hash: h, venue: next.venue, symbols: next.symbols, limits: limitsForLedger(next.limits) });
      s.cfgHash = h;
      return { status: 'saved', symbols: next.symbols, limits: next.limits };
    });
  }
}
