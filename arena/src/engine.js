// The arena engine: takes signed orders, fills them at the open of the next
// 1-minute candle under the same locks as the guard, marks every account every
// minute, and produces the standings. Given the same orders and the same public
// candles it always produces the same results, so anyone can recompute it.
//
// This file does no I/O. The caller feeds it orders and candles and stores what
// it returns (see engine/main.js).

import { createHash } from 'node:crypto';

import { applyFill, buyAt, equity as bookEquity, newBook, sellAt } from '../../guard/src/book.js';
import { canon } from '../../guard/src/canon.js';
import { verifyText } from '../../guard/src/keys.js';
import { GENESIS } from '../../guard/src/ledger.js';
import { ceilDiv, div, fmt, mul, parse } from '../../guard/src/money.js';
import { check, DEFAULT_LIMITS, DEFAULT_SYMBOLS } from '../../guard/src/rules.js';
import { BASELINES, baselineOrders } from './baselines.js';
import { maxDrawdownPct, rank, score } from './standings.js';

export const MINUTE = 60_000;

/** Words the videos refuse to render (same list as the video templates). Names and shown reasons must not carry them. */
export const BANNED = /稳赚|保证|保本|跟单|带单|信号|喊单|guarantee|risk[- ]?free|copy[- ]?trad|signals?\b|sure[- ]?win|to the moon/i;
const AGENT_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;
// Names are stricter than the video list: no "SignalBot", "ProfitMax", "翻倍王".
const NAME_BANNED = /signal|copy|guarant|profit|pump|moon|\d+x\b|翻倍|暴富|稳/i;

/** Throws if an agent's id, name or model cannot be shown on the board. */
export function checkAgent({ agentId, name, model, pubkey }) {
  if (!AGENT_RE.test(agentId ?? '')) throw new Error('agentId: 3–32 lowercase letters, digits and -');
  for (const [k, v] of [['name', name], ['model', model]]) {
    if (typeof v !== 'string' || !v.trim() || v.length > 40) throw new Error(`${k}: 1–40 characters`);
    if (BANNED.test(v) || NAME_BANNED.test(v)) throw new Error(`${k}: contains a word we do not show (returns promises, signals, copy trading)`);
  }
  if (typeof pubkey !== 'string' || Buffer.from(pubkey, 'base64').length !== 32) throw new Error('pubkey: 32-byte Ed25519 key, base64');
}

const shownReason = (r) => (BANNED.test(r) ? '(reason not shown: it uses a word we do not show)' : r);
const HOUR = 60 * MINUTE;
const MAX_SKEW_MS = 5 * MINUTE; // an order's own timestamp must be this close to when we got it
const REASON_MAX = 280;

const sha256 = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const iso = (ms) => new Date(ms).toISOString();
const utcDay = (ms) => iso(ms).slice(0, 10);
const floorMinute = (ms) => Math.floor(ms / MINUTE) * MINUTE;

/** Percent with two decimals from two unit amounts, rounded half away from zero. */
export function pct2(part, whole) {
  if (whole === 0n) return 0;
  const n = part * 1_000_000n; // percent × 10^4 after the division below
  const q = n / whole;
  const r = n % whole;
  // q is percent × 10^4; we want percent × 100 rounded
  const x = q + (2n * (r < 0n ? -r : r) >= whole ? (n < 0n ? -1n : 1n) : 0n);
  const hundredths = x / 100n + ((x % 100n) * 2n >= 100n ? 1n : (x % 100n) * 2n <= -100n ? -1n : 0n);
  return Number(hundredths) / 100;
}

/** ISO week id like 2026-W44 and its Monday 00:00 UTC. */
export function isoWeek(ms) {
  const d = new Date(utcDay(ms));
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
  const thursday = new Date(monday + 3 * 86_400_000);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / 86_400_000 / 7) + 1;
  return { id: `${year}-W${String(week).padStart(2, '0')}`, from: monday, to: monday + 7 * 86_400_000 };
}

/** The inverse of isoWeek(): '2026-W44' → its Monday and the next. */
export function isoWeekById(id) {
  const [y, w] = id.split('-W').map(Number);
  const jan4 = Date.UTC(y, 0, 4);
  const dow = (new Date(jan4).getUTCDay() + 6) % 7;
  const monday = jan4 - dow * 86_400_000 + (w - 1) * 7 * 86_400_000;
  return { id, from: monday, to: monday + 7 * 86_400_000 };
}

function freshPeriod(id, from, equity) {
  return { id, from, startEquity: equity, peak: equity, maxDd: 0, trades: 0, curve: [] };
}

export class Arena {
  /**
   * season: { id: 'S1', from: ms, to: ms }
   * rules: { symbols, limits, startCash: '10000' }
   */
  constructor({ season, rules = {} } = {}) {
    this.season = season;
    this.symbols = rules.symbols ?? [...DEFAULT_SYMBOLS];
    this.limits = rules.limits ?? { ...DEFAULT_LIMITS };
    this.startCash = parse(rules.startCash ?? '10000');
    this.agents = {}; // agentId → account
    this.queue = []; // accepted-for-processing orders waiting for their minute
    this.minute = null; // last minute fully processed (open time, ms)
    this.weekId = null; // the ISO week being counted
    this.weekFills = []; // this week's sells, for the "one trade" highlights
    this.closed = []; // finished weeks and seasons, waiting to be published
    this.seasonClosed = false;
    this.lastCloses = null; // closing prices of the last processed minute (strings)
  }

  // ---------- agents ----------

  /** Add one of the fixed baselines (see baselines.js). They have no key: nobody can send orders for them. */
  addBaseline(agentId, joined) {
    const b = BASELINES[agentId];
    if (!b) throw new Error(`unknown baseline ${agentId}`);
    const ev = this._add({ agentId, name: b.name, model: b.model, official: true, pubkey: null, joined });
    this.agents[agentId].baseline = true;
    return ev;
  }

  /** Add an agent. `joined` (ms) is when its money starts counting. */
  addAgent({ agentId, name, model, official = false, pubkey, joined }) {
    checkAgent({ agentId, name, model, pubkey });
    if (BASELINES[agentId]) throw new Error(`${agentId} is reserved for a baseline`);
    return this._add({ agentId, name, model, official: false, pubkey, joined });
  }

  _add({ agentId, name, model, official, pubkey, joined }) {
    if (this.agents[agentId]) throw new Error(`agent ${agentId} already in`);
    this.agents[agentId] = {
      agentId, name, model, official, pubkey, joined,
      status: 'active',
      book: newBook(this.startCash),
      avgCost: {}, // symbol → units of USDT per coin, fees included
      lastSeq: -1,
      lastHash: GENESIS,
      accepted: [], // recv times of orders that passed
      day: null, // { date, startEquity }
      week: null,
      seasonP: null,
      hourly: [], // [hour ms, equity units] for curves
    };
    return [{ type: 'join', agent: agentId, name, model, official, pubkey, at: iso(joined) }];
  }

  // ---------- orders ----------

  /**
   * An order arrived. `line` is the agent's signed canonical JSON, `recv` our clock.
   * Returns events: a `recv` (queued) or a `reject` (bad signature, chain, input).
   */
  receive({ line, recv }) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return [{ type: 'reject', agent: null, rule: 'bad_input', message: 'not JSON', recv: iso(recv) }];
    }
    const a = this.agents[o.agent];
    const no = (rule, message) => [{ type: 'reject', agent: o.agent ?? null, seq: o.seq ?? null, rule, message, recv: iso(recv) }];
    if (!a) return no('unknown_agent', 'agent is not registered for this season');
    if (canon(o) !== line) return no('bad_input', 'order line is not canonical JSON');
    const { sig, ...body } = o;
    if (o.v !== 1 || o.type !== 'order') return no('bad_input', 'not a v1 order');
    if (!sig || !verifyText(a.pubkey, canon(body), sig)) return no('bad_signature', 'signature does not match the registered key');
    if (o.seq !== a.lastSeq + 1 || o.prev !== a.lastHash) return no('bad_chain', `expected seq ${a.lastSeq + 1} chained to the previous order`);
    if (Math.abs(Date.parse(o.ts) - recv) > MAX_SKEW_MS) return no('bad_time', 'order time is more than 5 minutes off');

    // The chain moves on even if the order is refused below: it was signed and received.
    a.lastSeq = o.seq;
    a.lastHash = sha256(line);
    if (a.status !== 'active') return no(a.status === 'out' ? 'out' : 'halted', `agent is ${a.status}`);
    if (recv < a.joined || recv >= this.season.to) return no('closed', 'outside the season');
    if (typeof o.reason !== 'string' || !o.reason.trim() || o.reason.length > REASON_MAX) {
      return no('bad_input', `reason required, at most ${REASON_MAX} characters`);
    }
    const item = { agent: o.agent, seq: o.seq, recv, minute: floorMinute(recv) + MINUTE, symbol: o.symbol, side: o.side, usdt: o.usdt, qty: o.qty, reason: o.reason };
    // Only if the engine fell more than a minute behind the front door; it waits 20 s to avoid this.
    if (this.minute != null && item.minute <= this.minute) return no('late', 'reached the engine after its minute was settled');
    this.queue.push(item);
    return [{ type: 'recv', agent: o.agent, seq: o.seq, recv: iso(recv), fill_minute: iso(item.minute), order: o }];
  }

  // ---------- the clock ----------

  /**
   * Process every whole minute up to (not including) the minute that contains `now`.
   * candles.open(symbol, minuteMs) / candles.close(symbol, minuteMs) return price
   * strings, or undefined if missing (then we stop and try again next time).
   * Returns the events produced.
   */
  advance(now, candles) {
    const events = [];
    const last = Math.min(floorMinute(now) - MINUTE, this.season.to - MINUTE); // newest complete minute in the season
    let m = this.minute == null ? floorMinute(this.season.from) : this.minute + MINUTE;
    for (; m <= last; m += MINUTE) {
      const done = this._minute(m, candles, events);
      if (!done) break;
      this.minute = m;
    }
    if (!this.seasonClosed && this.minute != null && this.minute + MINUTE >= this.season.to) {
      const asOf = iso(this.season.to);
      this.closed.push({ kind: 'week', id: this.weekId, asOf, rows: this.rows('week'), highlights: this._highlights() });
      this.closed.push({ kind: 'season', id: this.season.id, asOf, rows: this.rows('season') });
      this.seasonClosed = true;
      events.push({ type: 'season_end', season: this.season.id, at: asOf });
    }
    return events;
  }

  _highlights() {
    const sells = this.weekFills;
    if (!sells.length) return {};
    const by = (a, b) => Number(a.pnlUsdt) - Number(b.pnlUsdt);
    const sorted = [...sells].sort(by);
    const show = (f) => ({ ...f, reason: shownReason(f.reason) });
    return { bestTrade: show(sorted[sorted.length - 1]), worstTrade: show(sorted[0]) };
  }

  _prices(candles, m, field) {
    const out = {};
    for (const s of this.symbols) {
      const v = candles[field](s, m);
      if (v === undefined) return null;
      out[s] = parse(v);
    }
    return out;
  }

  _minute(m, candles, events) {
    this._source = candles.source; // which exchange's candle a price came from, if the caller knows
    const opens = this._prices(candles, m, 'open');
    const closes = this._prices(candles, m, 'close');
    if (!opens || !closes) return false;

    const wkNow = isoWeek(m);
    if (this.weekId && this.weekId !== wkNow.id) {
      this.closed.push({ kind: 'week', id: this.weekId, asOf: iso(m), rows: this.rows('week'), highlights: this._highlights() });
      this.weekFills = [];
      events.push({ type: 'week_end', week: this.weekId, at: iso(m) });
    }
    this.weekId = wkNow.id;

    for (const a of Object.values(this.agents)) {
      if (a.joined > m) continue;
      // Period starts (day, week, season) are valued at this minute's open.
      const eqOpen = bookEquity(a.book, opens);
      if (a.day?.date !== utcDay(m)) {
        a.day = { date: utcDay(m), startEquity: eqOpen };
        events.push({ type: 'day', agent: a.agentId, date: a.day.date, start_equity: fmt(eqOpen) });
      }
      const wk = isoWeek(m);
      if (a.week?.id !== wk.id) a.week = freshPeriod(wk.id, Math.max(wk.from, a.joined), eqOpen);
      if (!a.seasonP) a.seasonP = freshPeriod(this.season.id, Math.max(this.season.from, a.joined), eqOpen);
    }

    // Fills for orders whose minute this is, in the order they arrived.
    const due = this.queue.filter((q) => q.minute === m).sort((x, y) => x.recv - y.recv || x.seq - y.seq);
    this.queue = this.queue.filter((q) => q.minute !== m);
    for (const q of due) events.push(...this._fill(q, m, opens));

    // Baselines decide on this minute's closes; their orders fill at the next minute's open.
    for (const a of Object.values(this.agents)) {
      if (!a.baseline || a.status !== 'active' || a.joined > m) continue;
      if (a.startedAt == null) a.startedAt = m;
      const orders = baselineOrders({
        kind: a.agentId, m, startedAt: a.startedAt, book: a.book, closes, equity: bookEquity(a.book, closes),
        daily: candles.daily,
      });
      for (const o of orders) {
        a.lastSeq += 1;
        const item = { agent: a.agentId, seq: a.lastSeq, recv: m, minute: m + MINUTE, symbol: o.symbol, side: o.side, usdt: o.usdt, qty: o.qty, reason: o.reason };
        this.queue.push(item);
        events.push({ type: 'recv', agent: a.agentId, seq: item.seq, recv: iso(m), fill_minute: iso(item.minute), order: { by: 'baseline', symbol: o.symbol, side: o.side, ...(o.usdt ? { usdt: o.usdt } : { qty: o.qty }), reason: o.reason } });
      }
    }

    // Marks at this minute's close: drawdown, the loss breaker, hourly curve points.
    for (const a of Object.values(this.agents)) {
      if (a.joined > m) continue;
      const eq = bookEquity(a.book, closes);
      for (const p of [a.week, a.seasonP]) {
        if (eq > p.peak) p.peak = eq;
        const dd = pct2(p.peak - eq, p.peak);
        if (dd > p.maxDd) p.maxDd = dd;
      }
      if (a.status === 'active' && eq * 10000n <= this.startCash * (10000n - BigInt(Math.round(this.limits.max_loss_pct * 100)))) {
        a.status = 'out';
        events.push({ type: 'out', agent: a.agentId, reason: 'max_loss', minute: iso(m), equity: fmt(eq) });
      }
      if ((m + MINUTE) % HOUR === 0) {
        a.hourly.push([m + MINUTE, eq]);
        events.push({ type: 'mark', agent: a.agentId, hour: iso(m + MINUTE), equity: fmt(eq) });
      }
      a.lastEquity = eq;
      a.lastMark = m + MINUTE;
    }
    this.lastCloses = Object.fromEntries(Object.entries(closes).map(([k, v]) => [k, fmt(v)]));
    return true;
  }

  _fill(q, m, opens) {
    const a = this.agents[q.agent];
    const no = (rule, message) => [{ type: 'reject', agent: q.agent, seq: q.seq, rule, message, minute: iso(m) }];
    if (a.status !== 'active') return no(a.status, `agent is ${a.status}`);
    const order = { symbol: q.symbol, side: q.side };
    try {
      if (q.side === 'buy') order.quote = parse(q.usdt);
      else if (q.side === 'sell') {
        const held = a.book.pos[q.symbol] ?? 0n;
        if (q.qty === 'all') order.qty = held;
        else if (q.qty != null) order.qty = parse(q.qty);
        else if (q.usdt != null && opens[q.symbol]) {
          const want = div(parse(q.usdt), opens[q.symbol]);
          order.qty = want > held ? held : want;
        }
      }
    } catch {
      return no('bad_input', 'amounts must be decimal strings');
    }
    const verdict = check(order, {
      halted: false,
      symbols: this.symbols,
      limits: this.limits,
      cash: a.book.cash,
      reservedCash: 0n,
      pos: a.book.pos,
      reservedQty: {},
      pendingBuy: {},
      prices: opens,
      priceTime: Object.fromEntries(this.symbols.map((s) => [s, m])),
      equity: bookEquity(a.book, opens),
      dayStartEquity: a.day?.startEquity ?? null,
      startCash: this.startCash,
      acceptedTimes: a.accepted,
      now: m,
    });
    if (!verdict.ok) return no(verdict.rule, verdict.message);

    const price = opens[q.symbol];
    const f = q.side === 'buy' ? buyAt(order.quote, price) : sellAt(order.qty, price);
    let pnl;
    if (q.side === 'buy') {
      const held = a.book.pos[q.symbol] ?? 0n;
      const cost = mul(held, a.avgCost[q.symbol] ?? 0n) + f.notional + f.fee;
      a.avgCost[q.symbol] = div(cost, held + f.qty);
    } else {
      const basis = mul(f.qty, a.avgCost[q.symbol] ?? price);
      pnl = { usdt: fmt(f.notional - f.fee - basis), pct: pct2(f.notional - f.fee - basis, basis) };
    }
    applyFill(a.book, { ...f, side: q.side, symbol: q.symbol });
    if (!a.book.pos[q.symbol]) delete a.avgCost[q.symbol];
    a.accepted.push(q.recv);
    a.accepted = a.accepted.filter((t) => m - t < 48 * HOUR);
    a.week.trades += 1;
    a.seasonP.trades += 1;
    if (pnl) {
      this.weekFills.push({
        agentId: a.agentId, name: a.name, time: iso(m), symbol: q.symbol, side: 'sell',
        qty: fmt(f.qty, { trim: true }), price: fmt(price, { trim: true }), usdt: fmt(f.notional).replace(/(\.\d{2})\d+$/, '$1'),
        pnlUsdt: pnl.usdt.replace(/(\.\d{2})\d+$/, '$1'), pnlPct: pnl.pct, reason: q.reason,
      });
    }
    return [{
      type: 'fill', agent: q.agent, seq: q.seq, symbol: q.symbol, side: q.side,
      qty: fmt(f.qty), price: fmt(price), notional: fmt(f.notional), fee: fmt(f.fee),
      cash: fmt(a.book.cash), minute: iso(m), reason: q.reason, source: this._source?.(q.symbol, m) ?? 'binance',
      ...(pnl ? { pnl_usdt: pnl.usdt, pnl_pct: String(pnl.pct) } : {}),
    }];
  }

  // ---------- results ----------

  /** Rows for one period kind ('week' or 'season'), ranked. */
  rows(kind) {
    const rows = [];
    for (const a of Object.values(this.agents)) {
      const p = kind === 'week' ? a.week : a.seasonP;
      if (!p || a.lastEquity == null) continue;
      const ret = pct2(a.lastEquity - p.startEquity, p.startEquity);
      const step = kind === 'week' ? HOUR : 4 * HOUR;
      const pts = a.hourly.filter(([t]) => t > p.from && (t - p.from) % step === 0)
        .map(([, e]) => pct2(e - p.startEquity, p.startEquity));
      const curve = [0, ...pts];
      if (curve[curve.length - 1] !== ret || curve.length < 2) curve.push(ret);
      rows.push({
        agentId: a.agentId,
        name: a.name,
        model: a.model,
        official: a.official,
        returnPct: ret,
        maxDrawdownPct: p.maxDd,
        score: score(ret, p.maxDd),
        trades: p.trades,
        equityUsdt: fmt(a.lastEquity).replace(/(\.\d{2})\d+$/, '$1'),
        seasonReturnPct: a.seasonP ? pct2(a.lastEquity - a.seasonP.startEquity, a.seasonP.startEquity) : ret,
        status: a.status,
        updatedAt: `${iso(a.lastMark).slice(0, 16).replace('T', ' ')} UTC`,
        curve: curve.slice(-400),
      });
    }
    return rank(rows);
  }

  /**
   * A standings document for the website, videos and posts.
   * Without `closed`: the live board for the current week or season.
   * With `closed` (an entry from this.closed): the final board for that period.
   */
  standings(kind, { sample = false, source, closed } = {}) {
    let period;
    if (kind === 'season') {
      period = { kind, id: this.season.id, from: iso(this.season.from), to: iso(this.season.to) };
    } else {
      const wk = closed ? isoWeekById(closed.id) : isoWeek(this.minute == null ? this.season.from : this.minute);
      period = { kind, id: wk.id, from: iso(Math.max(wk.from, this.season.from)), to: iso(Math.min(wk.to, this.season.to)) };
    }
    const doc = {
      schema: 'arena.standings/v0',
      season: this.season.id,
      period,
      asOf: closed ? closed.asOf : iso(this.minute == null ? this.season.from : this.minute + MINUTE),
      source,
      sample,
      startUsdt: fmt(this.startCash, { trim: true }),
      scoring: 'score = returnPct - 0.5 × maxDrawdownPct; ties: higher returnPct, then fewer trades',
      disclaimer: {
        zh: '模拟盘，过去不代表未来，不是投资建议。',
        en: "Simulated trading. Past results don't predict future results. Not investment advice.",
      },
      rows: closed ? closed.rows : this.rows(kind),
    };
    const hl = closed ? closed.highlights : kind === 'week' ? this._highlights() : null;
    if (hl && Object.keys(hl).length) doc.highlights = hl;
    return doc;
  }

  /** What an agent (and anyone) sees about one account: for the decision snapshot and the site. */
  accountView(agentId, now) {
    const a = this.agents[agentId];
    if (!a) return null;
    const prices = this.lastCloses ? Object.fromEntries(Object.entries(this.lastCloses).map(([k, v]) => [k, parse(v)])) : null;
    const eq = prices ? bookEquity(a.book, prices) : a.book.cash;
    const L = this.limits;
    const hour = a.accepted.filter((t) => now - t < HOUR).length;
    const today = a.accepted.filter((t) => utcDay(t) === utcDay(now)).length;
    const dayLocked = a.day && eq * 10000n <= a.day.startEquity * (10000n - BigInt(Math.round(L.daily_loss_pct * 100)));
    return {
      agentId,
      name: a.name,
      status: a.status,
      asOf: iso(a.lastMark ?? a.joined),
      startUsdt: fmt(this.startCash, { trim: true }),
      cashUsdt: fmt(a.book.cash, { trim: true }),
      equityUsdt: fmt(eq, { trim: true }),
      seasonReturnPct: a.seasonP ? pct2(eq - a.seasonP.startEquity, a.seasonP.startEquity) : 0,
      today: a.day ? { startEquityUsdt: fmt(a.day.startEquity, { trim: true }), returnPct: pct2(eq - a.day.startEquity, a.day.startEquity), buysAllowed: !dayLocked && a.status === 'active' } : null,
      positions: Object.entries(a.book.pos).map(([symbol, qty]) => ({
        symbol, qty: fmt(qty, { trim: true }), price: this.lastCloses?.[symbol] ?? null,
        valueUsdt: prices ? fmt(mul(qty, prices[symbol]), { trim: true }) : null,
        avgCostUsdt: a.avgCost[symbol] != null ? fmt(a.avgCost[symbol], { trim: true }) : null,
      })),
      pendingOrders: this.queue.filter((q) => q.agent === agentId).map((q) => ({ seq: q.seq, symbol: q.symbol, side: q.side, usdt: q.usdt, qty: q.qty, fillsAt: iso(q.minute) })),
      ordersLeft: { thisHour: Math.max(L.max_orders_per_hour - hour, 0), today: Math.max(L.max_orders_per_day - today, 0) },
      lastSeq: a.lastSeq,
      lastHash: a.lastHash,
    };
  }

  // ---------- saving ----------

  toJSON() {
    const big = (v) => (typeof v === 'bigint' ? `${v}n` : v);
    const { _source, ...plain } = this;
    return JSON.parse(JSON.stringify(plain, (k, v) => big(v)));
  }

  static fromJSON(j) {
    const back = (v) => (typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);
    const revive = (o) => {
      if (Array.isArray(o)) return o.map(revive);
      if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, revive(v)]));
      return back(o);
    };
    const a = new Arena({ season: j.season });
    Object.assign(a, revive(j));
    return a;
  }
}

export { maxDrawdownPct, ceilDiv };
