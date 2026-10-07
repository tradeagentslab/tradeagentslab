#!/usr/bin/env node
// The house agents' decision run (on the operator's own computer, a few times a day).
// For each agent: fetch the same snapshot and its account from the arena (never from
// an exchange), ask its CLI for a JSON decision with every tool and web search off,
// check the answer, sign the orders and send them to the arena. The arena executes.
//
//   node runner/run.mjs --config ~/.arena-runner/config.json [--only ID] [--dry-run]

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BRAND } from '../../guard/src/brand.js';
import { writeJson } from '../../guard/src/config.js';
import { loadOrCreateKey, publicRaw } from '../../guard/src/keys.js';
import { GENESIS } from '../../guard/src/ledger.js';
import { DEFAULT_LIMITS, DEFAULT_SYMBOLS } from '../../guard/src/rules.js';
import { makeOrder } from '../src/orders.js';

export const MAX_ORDERS = 3;

export function decisionSchema(symbols = DEFAULT_SYMBOLS) {
  return {
    type: 'object',
    properties: {
      orders: {
        type: 'array',
        maxItems: MAX_ORDERS,
        items: {
          type: 'object',
          properties: {
            symbol: { type: 'string', enum: symbols },
            side: { type: 'string', enum: ['buy', 'sell'] },
            usdt: { type: ['number', 'null'], description: 'buy: USDT to spend; sell: null' },
            qty: { type: ['string', 'null'], description: 'sell: coin amount or "all"; buy: null' },
            reason: { type: 'string', maxLength: 280 },
          },
          required: ['symbol', 'side', 'usdt', 'qty', 'reason'],
          additionalProperties: false,
        },
      },
      note: { type: 'string', maxLength: 500 },
    },
    required: ['orders', 'note'],
    additionalProperties: false,
  };
}

/** The same prompt for every agent; only the name and its own account differ. */
export function buildPrompt({ name, account, snapshot, limits = DEFAULT_LIMITS, symbols = DEFAULT_SYMBOLS }) {
  return `You are ${name}, one of the house agents in a public paper-trading arena run by ${BRAND.name}.
Everything is simulated: paper money, spot only, no leverage, no shorting. You decide; a separate engine executes.
You have no tools and no web access. Use only the data below.

Rules the engine enforces (orders that break them are rejected):
- Tradable: ${symbols.join(', ')}. Market orders fill at the open of the next 1-minute candle; fee 0.1% per side.
- One order: at least ${limits.min_order_usdt} USDT and at most ${limits.max_order_pct}% of equity. One coin: at most ${limits.max_symbol_pct}% of equity.
- After a ${limits.daily_loss_pct}% loss since 00:00 UTC: sells only for the rest of that day.
- At most ${limits.max_orders_per_hour} orders an hour, ${limits.max_orders_per_day} a day, ${MAX_ORDERS} per decision.
- If equity falls to ${100 - limits.max_loss_pct}% of the starting money (a ${limits.max_loss_pct}% loss), you are out for the season.

You decide four times a day (00, 06, 12 and 18 UTC). Holding is a valid decision.
Your reasons are published next to each trade. Write plainly and do not predict returns.

Your account:
${JSON.stringify(account)}

Market snapshot (hourly candles, oldest first: open_time, open, high, low, close, volume):
${JSON.stringify(snapshot)}

Answer with JSON only, in this shape:
{"orders":[{"symbol":"ETHUSDT","side":"buy","usdt":250,"qty":null,"reason":"..."}],"note":"one line for your journal"}
For a buy set usdt and qty null. For a sell set qty (a coin amount, or "all") and usdt null. "orders": [] means hold.`;
}

/** How to call each CLI in one-shot mode with tools and web search off. */
export function cliCommand(kind, { bin, model, prompt, schema, workdir }) {
  if (kind === 'claude') {
    return {
      bin: bin ?? 'claude',
      args: ['-p', prompt, '--tools', '', '--strict-mcp-config', '--no-session-persistence',
        '--output-format', 'json', '--json-schema', JSON.stringify(schema), ...(model ? ['--model', model] : [])],
    };
  }
  if (kind === 'codex') {
    const schemaFile = join(workdir, 'schema.json');
    const outFile = join(workdir, 'answer.json');
    writeFileSync(schemaFile, JSON.stringify(schema));
    return {
      bin: bin ?? 'codex',
      args: ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '-C', workdir,
        '--output-schema', schemaFile, '-o', outFile, ...(model ? ['-m', model] : []), prompt],
      outFile,
    };
  }
  if (kind === 'grok') {
    return {
      bin: bin ?? 'grok',
      args: ['-p', prompt, '--disable-web-search', '--tools', '', '--max-turns', '1',
        '--json-schema', JSON.stringify(schema), ...(model ? ['-m', model] : [])],
    };
  }
  throw new Error(`unknown cli kind: ${kind}`);
}

/** Pull the decision object out of whatever wrapper a CLI printed. */
export function parseDecision(text) {
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
  const unwrap = (v) => {
    if (!v || typeof v !== 'object') return undefined;
    if (Array.isArray(v.orders)) return v;
    for (const k of ['structured_output', 'structuredOutput', 'output', 'result', 'response', 'text', 'content']) {
      const inner = v[k];
      if (typeof inner === 'string') {
        const got = unwrap(tryParse(inner) ?? tryParse(inner.slice(inner.indexOf('{'), inner.lastIndexOf('}') + 1)));
        if (got) return got;
      } else if (inner && typeof inner === 'object') {
        const got = unwrap(inner);
        if (got) return got;
      }
    }
    return undefined;
  };
  const t = String(text ?? '').trim();
  return unwrap(tryParse(t)) ?? unwrap(tryParse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1))) ?? null;
}

/** Keep only well-formed orders (the arena checks the limits). Returns { orders, dropped, note }. */
export function cleanDecision(d, symbols = DEFAULT_SYMBOLS) {
  const orders = [];
  const dropped = [];
  for (const o of (Array.isArray(d?.orders) ? d.orders : []).slice(0, MAX_ORDERS)) {
    const symbol = String(o?.symbol ?? '').toUpperCase();
    const reason = String(o?.reason ?? '').trim().slice(0, 280);
    const bad = (why) => dropped.push({ order: o, why });
    if (!symbols.includes(symbol)) { bad('symbol not tradable'); continue; }
    if (!reason) { bad('no reason'); continue; }
    if (o.side === 'buy') {
      if (!(typeof o.usdt === 'number' && o.usdt > 0)) { bad('buy needs usdt'); continue; }
      orders.push({ symbol, side: 'buy', usdt: Math.floor(o.usdt * 100) / 100, reason });
    } else if (o.side === 'sell') {
      const q = o.qty === 'all' ? 'all' : String(o.qty ?? '');
      if (q !== 'all' && !/^\d+(\.\d+)?$/.test(q)) { bad('sell needs qty'); continue; }
      orders.push({ symbol, side: 'sell', qty: q, reason });
    } else bad('side must be buy or sell');
  }
  if ((d?.orders?.length ?? 0) > MAX_ORDERS) dropped.push({ why: `only the first ${MAX_ORDERS} orders are used` });
  return { orders, dropped, note: String(d?.note ?? '').slice(0, 500) };
}

export async function runAgent({ agent, api, home, snapshot, fetchImpl = globalThis.fetch, exec, now = Date.now, dryRun = false }) {
  const started = now();
  const keysDir = join(home, 'keys');
  const key = loadOrCreateKey(join(keysDir, `${agent.agentId}.key`));
  const chainFile = join(keysDir, `${agent.agentId}.chain.json`);
  let chain = existsSync(chainFile) ? JSON.parse(readFileSync(chainFile, 'utf8')) : { seq: -1, hash: GENESIS };

  const accRes = await fetchImpl(`${api}/accounts/${agent.agentId}.json`);
  if (!accRes.ok) throw new Error(`account: HTTP ${accRes.status}`);
  const account = await accRes.json();
  if (account.status !== 'active') return { agentId: agent.agentId, skipped: `status ${account.status}` };

  const workdir = mkdtempSync(join(tmpdir(), 'arena-decide-'));
  try {
    const cmd = cliCommand(agent.cli, {
      bin: agent.bin, model: agent.model, workdir, schema: decisionSchema(),
      prompt: buildPrompt({ name: agent.name, account, snapshot }),
    });
    const r = exec(cmd.bin, cmd.args, { cwd: workdir, timeoutMs: (agent.timeoutSec ?? 300) * 1000 });
    if (r.status !== 0) throw new Error(`${agent.cli} exited ${r.status}: ${String(r.stderr || r.stdout).trim().split('\n')[0]}`);
    const text = cmd.outFile && existsSync(cmd.outFile) ? readFileSync(cmd.outFile, 'utf8') : r.stdout;
    const decision = parseDecision(text);
    if (!decision) throw new Error(`${agent.cli} gave no usable JSON`);
    const clean = cleanDecision(decision);

    const posted = [];
    for (const o of clean.orders) {
      if (dryRun) { posted.push({ ...o, dryRun: true }); continue; }
      for (let attempt = 0; attempt < 2; attempt++) {
        const { line, next } = makeOrder({ key, agent: agent.agentId, state: chain, now: now(), ...o });
        const res = await fetchImpl(`${api}/orders`, { method: 'POST', body: line });
        const body = await res.json().catch(() => ({}));
        if (res.status === 409 && body.rule === 'bad_chain' && body.expected_prev && attempt === 0) {
          chain = { seq: body.expected_seq - 1, hash: body.expected_prev }; // the arena knows our last line; follow it
          continue;
        }
        if (res.ok) {
          chain = next;
          writeJson(chainFile, chain);
        }
        posted.push({ ...o, status: res.status, rule: body.rule, id: body.id, recv: body.recv });
        break;
      }
    }
    return { agentId: agent.agentId, cli: agent.cli, model: agent.model, note: clean.note, dropped: clean.dropped, posted, ms: now() - started };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

/** Decisions are due at 00, 06, 12 and 18 UTC. Later than this past the slot, the round is skipped, not made up. */
export const LATE_MS = 30 * 60_000;
export function lateBy(nowMs) {
  const slot = Math.floor(nowMs / (6 * 3600_000)) * 6 * 3600_000;
  return nowMs - slot;
}

export async function runAll({ config, fetchImpl = globalThis.fetch, exec = defaultExec, now = Date.now, only, dryRun = false, force = false, log = (s) => process.stderr.write(`${s}\n`) }) {
  // The Mac was asleep at the slot: record a skip, never decide after the fact.
  if (!force && lateBy(now()) > LATE_MS) {
    const r = { skipped: 'late', slot: new Date(now() - lateBy(now())).toISOString() };
    mkdirSync(join(config.home, 'log'), { recursive: true });
    appendFileSync(join(config.home, 'log', `${new Date(now()).toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify({ ts: new Date(now()).toISOString(), ...r })}\n`);
    log(`skipped: ${Math.round(lateBy(now()) / 60_000)} min after the ${r.slot.slice(11, 16)} UTC slot`);
    return [r];
  }
  const snapRes = await fetchImpl(`${config.api}/snapshot.json`);
  if (!snapRes.ok) throw new Error(`snapshot: HTTP ${snapRes.status}`);
  const snapshot = await snapRes.json();
  const results = [];
  for (const agent of config.agents) {
    if (only && agent.agentId !== only) continue;
    let r;
    try {
      r = await runAgent({ agent, api: config.api, home: config.home, snapshot, fetchImpl, exec, now, dryRun });
    } catch (err) {
      r = { agentId: agent.agentId, error: err.message };
    }
    results.push(r);
    const day = new Date(now()).toISOString().slice(0, 10);
    mkdirSync(join(config.home, 'log'), { recursive: true });
    appendFileSync(join(config.home, 'log', `${day}.jsonl`), `${JSON.stringify({ ts: new Date(now()).toISOString(), ...r })}\n`);
    log(r.error ? `${agent.agentId}: ${r.error}` : `${agent.agentId}: ${r.posted?.length ?? 0} orders${r.skipped ? ` (${r.skipped})` : ''}`);
  }
  return results;
}

function defaultExec(bin, args, { cwd, timeoutMs }) {
  return spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
}

/** Public keys to put in the arena roster, one per agent (creates keys on first use). */
export function publicKeys(config) {
  return config.agents.map((a) => ({ agentId: a.agentId, pubkey: publicRaw(loadOrCreateKey(join(config.home, 'keys', `${a.agentId}.key`))) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const config = JSON.parse(readFileSync(opt('--config'), 'utf8'));
  if (typeof config.home === 'string' && config.home.startsWith('~/')) config.home = join(homedir(), config.home.slice(2));
  if (args.includes('--pubkeys')) console.log(JSON.stringify(publicKeys(config), null, 2));
  else await runAll({ config, only: opt('--only'), dryRun: args.includes('--dry-run'), force: args.includes('--force') });
}
