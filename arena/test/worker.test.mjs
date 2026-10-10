import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { publicRaw, signText } from '../../guard/src/keys.js';
import { GENESIS } from '../../guard/src/ledger.js';
import { makeOrder } from '../src/orders.js';
import { handle, PREFIX } from '../worker/index.js';
import { d1 } from './d1shim.mjs';

const SCHEMA = fileURLToPath(new URL('../worker/schema.sql', import.meta.url));
const NOW = Date.parse('2026-10-28T06:00:10Z');
const BASE = `https://example.test${PREFIX}`;

function setup() {
  const engine = generateKeyPairSync('ed25519').privateKey;
  const agentKey = generateKeyPairSync('ed25519').privateKey;
  const env = { DB: d1([SCHEMA]), ENGINE_PUBKEY: publicRaw(engine) };
  let push = 0;
  const pushBundle = async (bundle, { key = engine, at = NOW } = {}) => {
    const body = JSON.stringify({ ts: new Date(at).toISOString(), push: ++push, ...bundle });
    const req = new Request(`${BASE}/engine`, { method: 'POST', body: JSON.stringify({ body, sig: signText(key, body) }) });
    return handle(req, env, at);
  };
  const agent = { key: agentKey, state: { seq: -1, hash: GENESIS } };
  const order = (extra = {}, at = NOW) => makeOrder({ key: agent.key, agent: 'tal-claude', state: agent.state, now: at, symbol: 'BTCUSDT', side: 'buy', usdt: 100, reason: 'test', ...extra });
  const post = (line, at = NOW) => handle(new Request(`${BASE}/orders`, { method: 'POST', body: line }), env, at);
  const get = (path) => handle(new Request(`${BASE}${path}`), env, NOW);
  return { env, engine, agent, pushBundle, order, post, get };
}

async function register(t) {
  return t.pushBundle({ agents: [{ agentId: 'tal-claude', name: 'Claude', model: 'Model X', official: true, pubkey: publicRaw(t.agent.key), joined: '2026-10-28T00:00:00Z' }] });
}

test('engine registers an agent; agents.json lists it', async () => {
  const t = setup();
  assert.equal((await register(t)).status, 200);
  const r = await (await t.get('/agents.json')).json();
  assert.equal(r.agents[0].agentId, 'tal-claude');
  assert.equal(r.agents[0].official, true);
});

test('a good order is stored with our receive time; the chain moves on', async () => {
  const t = setup();
  await register(t);
  const o = t.order();
  const res = await t.post(o.line);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.recv, '2026-10-28T06:00:10.000Z');
  t.agent.state = o.next;
  assert.equal((await t.post(t.order({ usdt: 50 }).line)).status, 201);
  const list = await (await t.get('/orders?after=0')).json();
  assert.deepEqual(list.orders.map((x) => x.agent), ['tal-claude', 'tal-claude']);
  assert.equal(list.orders[0].line, o.line);
});

test('refused: replay, wrong key, unknown agent, not canonical, too big, clock off', async () => {
  const t = setup();
  await register(t);
  const o = t.order();
  assert.equal((await t.post(o.line)).status, 201);
  const again = await t.post(o.line);
  assert.equal(again.status, 409);
  assert.equal((await again.json()).expected_seq, 1);

  const stranger = generateKeyPairSync('ed25519').privateKey;
  const forged = makeOrder({ key: stranger, agent: 'tal-claude', state: o.next, now: NOW, symbol: 'BTCUSDT', side: 'buy', usdt: 1, reason: 'x' });
  assert.equal((await t.post(forged.line)).status, 401);

  const nobody = makeOrder({ key: stranger, agent: 'nobody-here', now: NOW, symbol: 'BTCUSDT', side: 'buy', usdt: 1, reason: 'x' });
  assert.equal((await t.post(nobody.line)).status, 404);

  const parsed = JSON.parse(t.order().line);
  assert.equal((await t.post(JSON.stringify(parsed, null, 1))).status, 400);
  assert.equal((await t.post(`{"v":1,"pad":"${'x'.repeat(3000)}"}`)).status, 413);

  t.agent.state = o.next;
  const late = t.order({}, NOW - 10 * 60_000);
  assert.equal((await t.post(late.line)).status, 400);
});

test('two orders racing for the same seq: exactly one wins', async () => {
  const t = setup();
  await register(t);
  const a = t.order({ usdt: 10 });
  const b = t.order({ usdt: 20 });
  const [ra, rb] = await Promise.all([t.post(a.line), t.post(b.line)]);
  assert.deepEqual([ra.status, rb.status].sort(), [201, 409]);
  assert.equal((await (await t.get('/orders?after=0')).json()).orders.length, 1);
});

test('engine bundles: signature, rising push number, blobs and ledgers become public', async () => {
  const t = setup();
  await register(t);
  const o = t.order();
  await t.post(o.line);
  const stranger = generateKeyPairSync('ed25519').privateKey;
  assert.equal((await t.pushBundle({ blobs: {} }, { key: stranger })).status, 401);

  const standings = { schema: 'arena.standings/v0', rows: [] };
  const ok = await t.pushBundle({
    events: [{ seq: 1, agent: 'tal-claude', day: '2026-10-28', line: '{"type":"fill"}' }],
    blobs: { 'standings/latest': standings, 'accounts/tal-claude': { cash: '1' }, snapshot: { prices: {} } },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await (await t.get('/standings/latest.json')).json(), standings);
  assert.deepEqual(await (await t.get('/accounts/tal-claude.json')).json(), { cash: '1' });
  const led = await (await t.get('/ledger/tal-claude/2026-10-28.json')).json();
  assert.equal(led.orders[0].line, o.line);
  assert.deepEqual(led.results, ['{"type":"fill"}']);
  assert.equal((await t.pushBundle({ blobs: { 'secret/thing': 1 } })).status, 400, 'only known blob names');
  const health = await (await t.get('/health')).json();
  assert.equal(health.engine_seen, '2026-10-28T06:00:10.000Z');
});

test('unknown pages and methods', async () => {
  const t = setup();
  assert.equal((await t.get('/weekly/2026-W44.json')).status, 404);
  assert.equal((await t.get('/nope')).status, 404);
  assert.equal((await handle(new Request(`${BASE}/orders`, { method: 'DELETE' }), t.env, NOW)).status, 405);
  assert.equal((await handle(new Request('https://example.test/other'), t.env, NOW)).status, 404);
});

test('requests from mainland China get 451 with one line, whatever the path or method', async () => {
  const { handle } = await import('../worker/index.js');
  for (const [method, path] of [['GET', '/api/arena/v0/health'], ['GET', '/api/arena/v0/standings/latest.json'], ['POST', '/api/arena/v0/orders']]) {
    const r = new Request(`https://site.test${path}`, { method, body: method === 'POST' ? '{}' : undefined });
    Object.defineProperty(r, 'cf', { value: { country: 'CN' } });
    const res = await handle(r, {});
    assert.equal(res.status, 451, `${method} ${path}`);
    assert.match(await res.text(), /<p>本站不向中国大陆提供服务。<\/p>/);
  }
});

test('/health: engine_seen and settled_to (how far the engine has settled; null outside the season)', async () => {
  const t = setup();
  assert.deepEqual(await (await t.get('/health')).json(), { ok: true, engine_seen: null, settled_to: null });
  assert.equal((await t.pushBundle({ settledTo: '2026-10-28T06:00:00.000Z' })).status, 200);
  assert.deepEqual(await (await t.get('/health')).json(), { ok: true, engine_seen: '2026-10-28T06:00:10.000Z', settled_to: '2026-10-28T06:00:00.000Z' });
  // An engine that does not send the field leaves it as it was
  assert.equal((await t.pushBundle({})).status, 200);
  assert.equal((await (await t.get('/health')).json()).settled_to, '2026-10-28T06:00:00.000Z');
  for (const bad of ['soon', 123, {}]) assert.equal((await t.pushBundle({ settledTo: bad })).status, 400, `refused: ${JSON.stringify(bad)}`);
  assert.equal((await (await t.get('/health')).json()).settled_to, '2026-10-28T06:00:00.000Z');
  // Season over (or not started): null
  assert.equal((await t.pushBundle({ settledTo: null })).status, 200);
  assert.equal((await (await t.get('/health')).json()).settled_to, null);
  // Not part of any published file
  const standings = { schema: 'arena.standings/v0', rows: [] };
  await t.pushBundle({ settledTo: '2026-10-28T06:01:00.000Z', blobs: { 'standings/latest': standings } });
  assert.deepEqual(await (await t.get('/standings/latest.json')).json(), standings);
});
