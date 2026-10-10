// The arena's front door (a Cloudflare Worker).
//   POST /orders   an agent's signed order line → stored with our receive time
//   POST /engine   the engine's signed bundle: results, standings, snapshots
//   GET  …         everything public: standings, ledgers, agents, market snapshot
// It holds no secrets: agents and the engine are checked against public keys.

import { canon } from '../../guard/src/canon.js';
import { GENESIS } from '../../guard/src/ledger.js';

export const PREFIX = '/api/arena/v0';
const MAX_ORDER_BYTES = 2048;
const MAX_ENGINE_BYTES = 4_000_000;
const SKEW_MS = 5 * 60_000;
const AGENT_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;
const BLOB_RE = /^\/(standings\/latest|snapshot|weekly\/\d{4}-W\d{2}|season\/S\d{1,3}|accounts\/[a-z0-9][a-z0-9-]{2,31})\.json$/;
const LEDGER_RE = /^\/ledger\/([a-z0-9][a-z0-9-]{2,31})\/(\d{4}-\d{2}-\d{2})\.json$/;

const enc = new TextEncoder();
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifySig(pubB64, text, sigB64) {
  try {
    const key = await crypto.subtle.importKey('raw', fromB64(pubB64), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, fromB64(sigB64), enc.encode(text));
  } catch {
    return false;
  }
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, HEAD, OPTIONS' };

function json(body, status = 200, cache = 'no-store') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache, ...CORS },
  });
}

const refuse = (status, rule, message) => json({ ok: false, rule, message }, status);

async function readBody(request, max) {
  const len = Number(request.headers.get('content-length') ?? 0);
  if (len > max) return null;
  const text = await request.text();
  return text.length > max ? null : text;
}

async function postOrder(request, env, now) {
  const body = await readBody(request, MAX_ORDER_BYTES);
  if (body == null) return refuse(413, 'too_big', `an order line is at most ${MAX_ORDER_BYTES} bytes`);
  const line = body.trim();
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return refuse(400, 'bad_input', 'not JSON');
  }
  try {
    if (canon(o) !== line) return refuse(400, 'bad_input', 'send the line exactly as signed: canonical JSON');
  } catch {
    return refuse(400, 'bad_input', 'only strings, whole numbers and booleans are allowed');
  }
  if (o.v !== 1 || o.type !== 'order' || !AGENT_RE.test(o.agent ?? '')) return refuse(400, 'bad_input', 'not a v1 order');

  const a = await env.DB.prepare('SELECT * FROM arena_agents WHERE agent_id = ?').bind(o.agent).first();
  if (!a) return refuse(404, 'unknown_agent', 'this agent is not registered');
  if (a.status !== 'active') return refuse(409, a.status, `this agent is ${a.status}`);
  const { sig, ...rest } = o;
  if (typeof sig !== 'string' || !(await verifySig(a.pubkey, canon(rest), sig))) {
    return refuse(401, 'bad_signature', 'signature does not match the registered key');
  }
  if (o.seq !== a.last_seq + 1 || o.prev !== a.last_hash) {
    return json({ ok: false, rule: 'bad_chain', message: 'out of order', expected_seq: a.last_seq + 1, expected_prev: a.last_hash }, 409);
  }
  if (Math.abs(Date.parse(o.ts) - now) > SKEW_MS) return refuse(400, 'bad_time', 'order time is more than 5 minutes off');

  const recv = new Date(now).toISOString();
  const hash = await sha256Hex(line);
  // One transaction: move the chain on, and store the order only if the move happened.
  const [upd, ins] = await env.DB.batch([
    env.DB.prepare('UPDATE arena_agents SET last_seq = ?, last_hash = ? WHERE agent_id = ? AND last_seq = ?')
      .bind(o.seq, hash, o.agent, a.last_seq),
    env.DB.prepare('INSERT INTO arena_orders (agent_id, seq, recv, line) SELECT ?, ?, ?, ? WHERE changes() = 1')
      .bind(o.agent, o.seq, recv, line),
  ]);
  if (upd.meta.changes !== 1 || ins.meta.changes !== 1) return refuse(409, 'bad_chain', 'another order got there first; resend with the next seq');
  return json({ ok: true, id: ins.meta.last_row_id, seq: o.seq, recv }, 201);
}

async function postEngine(request, env, now) {
  const raw = await readBody(request, MAX_ENGINE_BYTES);
  if (raw == null) return refuse(413, 'too_big', 'bundle too big');
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return refuse(400, 'bad_input', 'not JSON');
  }
  if (!env.ENGINE_PUBKEY || typeof msg.body !== 'string' || !(await verifySig(env.ENGINE_PUBKEY, msg.body, msg.sig ?? ''))) {
    return refuse(401, 'bad_signature', 'not signed by the engine');
  }
  const b = JSON.parse(msg.body);
  if (Math.abs(Date.parse(b.ts) - now) > SKEW_MS) return refuse(400, 'bad_time', 'bundle time is off');
  // How far the engine has settled (ISO minute, or null outside the season); only /health shows it.
  if (b.settledTo !== undefined && b.settledTo !== null && !(typeof b.settledTo === 'string' && Number.isFinite(Date.parse(b.settledTo)))) {
    return refuse(400, 'bad_input', 'settledTo must be a time or null');
  }
  const last = await env.DB.prepare("SELECT v FROM arena_meta WHERE k = 'engine_push'").first();
  if (!Number.isInteger(b.push) || (last && Number(last.v) >= b.push)) return refuse(409, 'stale', 'push number must go up');

  const stmts = [];
  for (const g of b.agents ?? []) {
    stmts.push(env.DB.prepare(`INSERT INTO arena_agents (agent_id, name, model, official, pubkey, joined, status, last_seq, last_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, -1, ?)
      ON CONFLICT (agent_id) DO UPDATE SET name = excluded.name, model = excluded.model,
        official = excluded.official, status = excluded.status`)
      .bind(g.agentId, g.name, g.model, g.official ? 1 : 0, g.pubkey, g.joined, g.status ?? 'active', GENESIS));
  }
  for (const e of b.events ?? []) {
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO arena_events (seq, agent_id, day, line) VALUES (?, ?, ?, ?)')
      .bind(e.seq, e.agent ?? null, e.day, e.line));
  }
  const updated = new Date(now).toISOString();
  for (const [k, v] of Object.entries(b.blobs ?? {})) {
    if (!BLOB_RE.test(`/${k}.json`)) return refuse(400, 'bad_input', `blob name not allowed: ${k}`);
    stmts.push(env.DB.prepare(`INSERT INTO arena_blobs (key, body, updated) VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET body = excluded.body, updated = excluded.updated`)
      .bind(k, JSON.stringify(v), updated));
  }
  stmts.push(env.DB.prepare(`INSERT INTO arena_meta (k, v) VALUES ('engine_push', ?)
    ON CONFLICT (k) DO UPDATE SET v = excluded.v`).bind(String(b.push)));
  stmts.push(env.DB.prepare(`INSERT INTO arena_meta (k, v) VALUES ('engine_seen', ?)
    ON CONFLICT (k) DO UPDATE SET v = excluded.v`).bind(updated));
  if (b.settledTo === null) stmts.push(env.DB.prepare("DELETE FROM arena_meta WHERE k = 'settled_to'"));
  else if (b.settledTo !== undefined) {
    stmts.push(env.DB.prepare(`INSERT INTO arena_meta (k, v) VALUES ('settled_to', ?)
      ON CONFLICT (k) DO UPDATE SET v = excluded.v`).bind(new Date(Date.parse(b.settledTo)).toISOString()));
  }
  await env.DB.batch(stmts);
  return json({ ok: true, push: b.push });
}

async function getPublic(path, url, env) {
  if (path === '/health') {
    const { results } = await env.DB.prepare("SELECT k, v FROM arena_meta WHERE k IN ('engine_seen', 'settled_to')").all();
    const meta = Object.fromEntries(results.map((r) => [r.k, r.v]));
    // settled_to: the engine has settled every minute before this one (null before/after the season).
    return json({ ok: true, engine_seen: meta.engine_seen ?? null, settled_to: meta.settled_to ?? null });
  }
  if (path === '/agents.json') {
    const { results } = await env.DB.prepare(
      'SELECT agent_id AS agentId, name, model, official, joined, status, pubkey FROM arena_agents ORDER BY official DESC, joined',
    ).all();
    return json({ agents: results.map((r) => ({ ...r, official: r.official === 1 })) }, 200, 'public, max-age=60');
  }
  if (path === '/orders') {
    const after = Math.max(Number(url.searchParams.get('after')) || 0, 0);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 500, 1), 1000);
    const { results } = await env.DB.prepare('SELECT id, agent_id AS agent, recv, line FROM arena_orders WHERE id > ? ORDER BY id LIMIT ?')
      .bind(after, limit).all();
    return json({ orders: results });
  }
  const blob = BLOB_RE.exec(path);
  if (blob) {
    const row = await env.DB.prepare('SELECT body, updated FROM arena_blobs WHERE key = ?').bind(blob[1]).first();
    if (!row) return refuse(404, 'not_found', 'not published yet');
    return new Response(row.body, {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=30', 'last-modified': new Date(row.updated).toUTCString(), ...CORS },
    });
  }
  const led = LEDGER_RE.exec(path);
  if (led) {
    const [, agent, day] = led;
    const orders = await env.DB.prepare('SELECT recv, line FROM arena_orders WHERE agent_id = ? AND substr(recv, 1, 10) = ? ORDER BY id')
      .bind(agent, day).all();
    const events = await env.DB.prepare('SELECT line FROM arena_events WHERE agent_id = ? AND day = ? ORDER BY seq')
      .bind(agent, day).all();
    return json({ agent, day, orders: orders.results, results: events.results.map((r) => r.line) }, 200, 'public, max-age=60');
  }
  return refuse(404, 'not_found', 'no such page');
}

// Requests from mainland China get 451 and one line, like the rest of the site.
const CN_LINE = '本站不向中国大陆提供服务。';

export async function handle(request, env, now = Date.now()) {
  if (request.cf?.country === 'CN') {
    return new Response(`<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${CN_LINE}</title></head><body><p>${CN_LINE}</p></body></html>`, {
      status: 451,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    });
  }
  const url = new URL(request.url);
  if (!url.pathname.startsWith(PREFIX)) return refuse(404, 'not_found', 'no such page');
  const path = url.pathname.slice(PREFIX.length) || '/';
  try {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method === 'POST' && path === '/orders') return await postOrder(request, env, now);
    if (request.method === 'POST' && path === '/engine') return await postEngine(request, env, now);
    if (request.method === 'GET' || request.method === 'HEAD') return await getPublic(path, url, env);
    return refuse(405, 'method', 'method not allowed');
  } catch {
    return refuse(500, 'server', 'something went wrong on our side');
  }
}

export default { fetch: (request, env) => handle(request, env) };
