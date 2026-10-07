// Arena mode: the same buttons as paper mode, but orders go to the public arena.
// They are signed on this machine with the agent's own key and filled by the arena
// at the open of the next minute, under the season's rules. No exchange keys anywhere.

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { BRAND } from './brand.js';
import { configHash, loadConfig, pathsFor, withLock, writeJson } from './config.js';
import { GuardError, marketView, normalizeSymbol, PRICING } from './guard.js';
import { loadOrCreateKey, publicRaw } from './keys.js';
import { GENESIS, Ledger } from './ledger.js';
import { div, fmt, parse, show } from './money.js';
import { makeOrder } from './orders.js';
import { check, DEFAULT_LIMITS, DEFAULT_SYMBOLS } from './rules.js';

const REASON_MAX = 280;
const JOURNAL_MAX = 500;

export class ArenaGuard {
  constructor({ root, market, fetchImpl = globalThis.fetch, now = Date.now, agent } = {}) {
    this.root = root;
    this.market = market;
    this.fetch = fetchImpl;
    this.now = now;
    this.agent = agent;
  }

  async _op(fn) {
    const cfg = loadConfig(this.root);
    const agent = this.agent ?? cfg.agent;
    const p = pathsFor(this.root, agent);
    const stateFile = join(this.root, 'state', `${agent}.arena.json`);
    return withLock(p.lock, async () => {
      const key = loadOrCreateKey(p.key);
      const ledger = new Ledger({ dir: p.ledger, agent, key });
      const s = existsSync(stateFile)
        ? JSON.parse(readFileSync(stateFile, 'utf8'))
        : { chain: { seq: -1, hash: GENESIS }, halted: null, cfgHash: configHash(cfg) };
      const ctx = { cfg, p, ledger, key, agent, s, base: cfg.arena_url ?? BRAND.arena };
      if (ledger.head().seq === -1) {
        ledger.append('init', { venue: 'arena', arena: ctx.base, pubkey: publicRaw(key) }, this.now());
      }
      if (existsSync(p.halt) && !s.halted) this._halt(ctx, 'human', 'HALT file');
      if (configHash(cfg) !== s.cfgHash && !s.halted) this._halt(ctx, 'guard', 'config_changed');
      try {
        return await fn(ctx);
      } finally {
        writeJson(stateFile, s);
      }
    });
  }

  _halt(ctx, by, reason) {
    ctx.s.halted = { by, reason, ts: new Date(this.now()).toISOString() };
    ctx.ledger.append('halt', { by, reason }, this.now());
  }

  async _get(ctx, path) {
    const res = await this.fetch(`${ctx.base}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new GuardError(`arena: HTTP ${res.status}`);
    return res.json();
  }

  async _account(ctx) {
    const a = await this._get(ctx, `/accounts/${ctx.agent}.json`);
    if (!a) {
      throw new GuardError(`"${ctx.agent}" is not in the arena yet. Run: ${BRAND.short} arena join --name NAME --model MODEL, then sign up with what it prints.`);
    }
    return a;
  }

  // ---------- buttons ----------

  async marketData(args = {}) {
    return this._op(async ({ cfg }) => marketView(this.market, cfg, args, this.now()));
  }

  async account() {
    return this._op(async (ctx) => ({ venue: 'arena', halted_here: ctx.s.halted ?? false, ...(await this._account(ctx)) }));
  }

  async placeOrder(args = {}, by = 'agent') {
    return this._op(async (ctx) => {
      const { s, ledger } = ctx;
      const symbol = normalizeSymbol(args.symbol);
      const side = String(args.side ?? '').toLowerCase();
      const reason = String(args.reason ?? '').trim();
      const reject = (rule, message) => {
        ledger.append('order', { symbol, side, reason: reason.slice(0, REASON_MAX), by, verdict: 'rejected', rule, message, venue: 'arena' }, this.now());
        return { status: 'rejected', rule, message };
      };
      if (s.halted) return reject('halted', 'Trading from this machine is halted. Only a person can resume it.');
      if (!reason) return reject('bad_input', 'A reason is required: one or two sentences on why.');
      if (reason.length > REASON_MAX) return reject('bad_input', `Keep the reason under ${REASON_MAX} characters.`);
      if (!DEFAULT_SYMBOLS.includes(symbol)) return reject('symbol', `${symbol} is not on the list: ${DEFAULT_SYMBOLS.join(', ')}.`);
      if (side !== 'buy' && side !== 'sell') return reject('bad_input', 'side must be buy or sell.');

      // A quick check against the arena's own view, so obvious mistakes never leave this machine.
      // The arena checks everything again when it fills the order.
      const acct = await this._account(ctx);
      if (acct.status !== 'active') return reject(acct.status, `This agent is ${acct.status} in the arena (equity fell to ${100 - DEFAULT_LIMITS.max_loss_pct}% of the start: out for the season).`);
      const snap = await this._get(ctx, '/snapshot.json');
      const price = snap?.markets?.[symbol]?.price;
      const order = { symbol, side };
      const amount = {};
      try {
        if (side === 'buy') {
          if (args.usdt == null) return reject('bad_input', 'Buy needs usdt: how many USDT to spend.');
          order.quote = parse(typeof args.usdt === 'number' ? args.usdt : String(args.usdt));
          amount.usdt = fmt(order.quote);
        } else if (side === 'sell') {
          const held = parse(acct.positions.find((x) => x.symbol === symbol)?.qty ?? '0');
          if (args.qty === 'all') { order.qty = held; amount.qty = 'all'; }
          else if (args.qty != null) { order.qty = parse(typeof args.qty === 'number' ? args.qty : String(args.qty)); amount.qty = fmt(order.qty); }
          else if (args.usdt != null && price) {
            const want = div(parse(typeof args.usdt === 'number' ? args.usdt : String(args.usdt)), parse(price));
            order.qty = want > held ? held : want;
            amount.qty = fmt(order.qty);
          } else return reject('bad_input', 'Sell needs qty (or "all"), or usdt.');
        }
      } catch {
        return reject('bad_input', 'Amounts must be plain numbers like 100 or 0.0015.');
      }
      if (price) {
        const prices = {};
        for (const [k, v] of Object.entries(snap.markets)) prices[k] = parse(v.price);
        const verdict = check(order, {
          halted: false,
          symbols: DEFAULT_SYMBOLS,
          limits: DEFAULT_LIMITS,
          cash: parse(acct.cashUsdt),
          reservedCash: 0n,
          pos: Object.fromEntries(acct.positions.map((x) => [x.symbol, parse(x.qty)])),
          reservedQty: {},
          pendingBuy: {},
          prices,
          priceTime: Object.fromEntries(Object.keys(prices).map((k) => [k, this.now()])),
          equity: parse(acct.equityUsdt),
          dayStartEquity: acct.today ? parse(acct.today.startEquityUsdt) : null,
          startCash: parse(acct.startUsdt),
          acceptedTimes: [],
          now: this.now(),
        });
        if (!verdict.ok && verdict.rule !== 'stale_price') return reject(verdict.rule, verdict.message);
      }

      for (let attempt = 0; attempt < 2; attempt++) {
        const { line, next } = makeOrder({ key: ctx.key, agent: ctx.agent, state: s.chain, now: this.now(), symbol, side, reason, ...amount });
        const res = await this.fetch(`${ctx.base}/orders`, { method: 'POST', body: line, signal: AbortSignal.timeout(15_000) });
        const body = await res.json().catch(() => ({}));
        if (res.status === 409 && body.rule === 'bad_chain' && body.expected_prev && attempt === 0) {
          s.chain = { seq: body.expected_seq - 1, hash: body.expected_prev };
          continue;
        }
        if (!res.ok) return reject(body.rule ?? 'arena', body.message ?? `arena answered ${res.status}`);
        s.chain = next;
        ledger.append('order', { symbol, side, reason, by, verdict: 'sent', venue: 'arena', arena_id: body.id, recv: body.recv, line }, this.now());
        return {
          status: 'sent',
          seq: next.seq,
          received: body.recv,
          note: 'The arena fills it at the open of the next minute under the season rules. Check fills in a minute or two.',
        };
      }
      return reject('arena', 'could not get in line with the arena; try again');
    });
  }

  async cancelOrder() {
    return { status: 'not_available', message: 'Arena orders fill within about a minute and cannot be canceled.' };
  }

  /** Fills and refusals from the arena's public ledger, newest first. */
  async fills({ limit = 10 } = {}) {
    return this._op(async (ctx) => {
      const n = Math.min(Math.max(Number(limit) || 10, 1), 100);
      const days = [0, 1].map((d) => new Date(this.now() - d * 86_400_000).toISOString().slice(0, 10));
      const out = [];
      for (const day of days) {
        const led = await this._get(ctx, `/ledger/${ctx.agent}/${day}.json`);
        for (const line of led?.results ?? []) {
          const ev = JSON.parse(line);
          const d = ev.data ?? {};
          if (d.agent !== ctx.agent || !['fill', 'reject'].includes(ev.type)) continue;
          out.push(ev.type === 'fill'
            ? { type: 'fill', seq: d.seq, time: d.minute, symbol: d.symbol, side: d.side, qty: show(parse(d.qty), 8), price: show(parse(d.price), 8), usdt: show(parse(d.notional)), fee_usdt: show(parse(d.fee), 4), ...(d.pnl_usdt ? { pnl_usdt: d.pnl_usdt } : {}) }
            : { type: 'rejected', seq: d.seq, time: d.minute ?? d.recv, rule: d.rule, message: d.message });
        }
      }
      out.sort((a, b) => String(b.time).localeCompare(String(a.time)));
      return { fills: out.slice(0, n) };
    });
  }

  async rules() {
    return this._op(async ({ s }) => ({
      venue: 'arena',
      start_usdt: '10000',
      symbols: DEFAULT_SYMBOLS,
      limits: DEFAULT_LIMITS,
      pricing: PRICING,
      season: `Equity at ${100 - DEFAULT_LIMITS.max_loss_pct}% of the start (a ${DEFAULT_LIMITS.max_loss_pct}% loss) is out for the season.`,
      halted_here: s.halted ?? false,
    }));
  }

  async halt({ reason } = {}, by = 'agent') {
    return this._op(async (ctx) => {
      const why = String(reason ?? '').trim().slice(0, REASON_MAX) || 'no reason given';
      if (!ctx.s.halted) this._halt(ctx, by, why);
      return { status: 'halted', halted: ctx.s.halted, note: 'This machine stops sending orders. Positions in the arena stay as they are.', flatten_orders: [] };
    });
  }

  async resume() {
    return this._op(async (ctx) => {
      if (existsSync(ctx.p.halt)) unlinkSync(ctx.p.halt);
      if (!ctx.s.halted) return { status: 'not_halted' };
      ctx.s.cfgHash = configHash(ctx.cfg);
      ctx.s.halted = null;
      ctx.ledger.append('resume', { by: 'human' }, this.now());
      return { status: 'resumed' };
    });
  }

  async journal({ text } = {}) {
    return this._op(async (ctx) => {
      const t = String(text ?? '').trim();
      if (!t) throw new GuardError('journal needs text');
      const ev = ctx.ledger.append('journal', { text: t.slice(0, JOURNAL_MAX) }, this.now());
      return { status: 'saved', seq: ev.seq };
    });
  }

  async setConfig() {
    throw new GuardError('In arena mode the limits are the season rules; they cannot be changed here.');
  }

  /** What to send to sign up: the roster entry for this agent. */
  async signup({ name, model }) {
    return this._op(async (ctx) => ({
      agentId: ctx.agent,
      name: String(name ?? '').trim(),
      model: String(model ?? '').trim(),
      official: false,
      pubkey: publicRaw(ctx.key),
    }));
  }
}
