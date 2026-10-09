// Recomputing a published board from the public files, offline: a short season runs
// through the real engine loop and Worker (world.mjs), its results are written out
// the way the arena-data repository keeps them, and `tal arena recompute` checks them.
// Then single lines and fields are tampered with, and each must show up.

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { canon } from '../../guard/src/canon.js';
import { main } from '../../guard/src/cli.js';
import { loadOrCreateKey, signText } from '../../guard/src/keys.js';
import { GENESIS } from '../../guard/src/ledger.js';
import { makeOrder } from '../src/orders.js';
import { API, price, world } from './world.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FROM = Date.parse('2026-11-01T00:00:00Z'); // a Sunday: the season's first week (2026-W44) is one day long
const TO = Date.parse('2026-11-03T00:00:00Z'); // and it ends on Tuesday, in 2026-W45
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Candle files in the recompute's layout, from the same made-up prices the fake Binance serves. */
function writeCandles(dir) {
  for (const s of SYMBOLS) {
    mkdirSync(join(dir, s, '1m'), { recursive: true });
    for (let d = FROM; d < TO; d += DAY) {
      const rows = [];
      for (let t = d; t < d + DAY; t += MINUTE) rows.push([t, price(s, t), price(s, t), price(s, t), price(s, t + MINUTE - 1), '1']);
      writeFileSync(join(dir, s, '1m', `${day(d)}.json`), JSON.stringify(rows));
    }
  }
  mkdirSync(join(dir, 'BTCUSDT', '1d'), { recursive: true });
  for (let d = FROM - 20 * DAY; d < TO; d += DAY) {
    const p = price('BTCUSDT', d);
    writeFileSync(join(dir, 'BTCUSDT', '1d', `${day(d)}.json`), JSON.stringify([[d, p, p, p, price('BTCUSDT', d + DAY - 1), '1']]));
  }
}

let built;
/** Run the season once: one agent with four orders, the three baselines. */
function season() {
  built ??= (async () => {
    const w = world({
      season: { id: 'S1', from: FROM, to: TO },
      baselines: ['baseline-hold', 'baseline-dca', 'baseline-ma'],
      roster: (pubkey) => [{ agentId: 'my-agent', name: 'My Agent', model: 'Model X 1.0', pubkey, joined: '2026-11-01T00:00:00Z' }],
    });
    await w.catchUp();
    let state = { seq: -1, hash: GENESIS };
    const orders = [
      [FROM + 30_000, { symbol: 'ETHUSDT', side: 'buy', usdt: 500, reason: 'first look' }],
      [FROM + 5 * HOUR + 15_000, { symbol: 'BTCUSDT', side: 'buy', usdt: 800, reason: 'second' }],
      [FROM + 20 * HOUR + 40_000, { symbol: 'ETHUSDT', side: 'sell', qty: 'all', reason: 'take it off' }],
      [FROM + 26 * HOUR + 5_000, { symbol: 'SOLUSDT', side: 'buy', usdt: 300, reason: 'new week' }],
    ];
    for (const [t, o] of orders) {
      w.clock.t = Math.max(w.clock.t, t);
      const { line, next } = makeOrder({ key: w.agentKey, agent: 'my-agent', now: w.clock.t, state, ...o });
      const res = await w.fetchImpl(`${API}/orders`, { method: 'POST', body: line });
      assert.equal(res.status, 201);
      state = next;
      await w.catchUp(80);
    }
    w.clock.t = TO + 2 * MINUTE;
    await w.catchUp(80);

    // What the weekly snapshot copies into the arena-data repository.
    const data = mkdtempSync(join(tmpdir(), 'arena-data-'));
    const save = (rel, v) => {
      mkdirSync(join(data, rel, '..'), { recursive: true });
      writeFileSync(join(data, rel), `${JSON.stringify(v, null, 2)}\n`);
    };
    const agents = await w.get('/agents.json');
    save('agents.json', agents);
    save('config.json', { arenaKey: w.loop.pubkey() });
    for (const p of ['weekly/2026-W44', 'weekly/2026-W45', 'season/S1']) save(`${p}.json`, await w.get(`/${p}.json`));
    for (const a of agents.agents) {
      for (let d = FROM; d <= TO; d += DAY) {
        const led = await w.get(`/ledger/${a.agentId}/${day(d)}.json`);
        if (led.orders.length || led.results.length) save(`ledgers/${a.agentId}/${day(d)}.json`, led);
      }
    }
    const candles = mkdtempSync(join(tmpdir(), 'candles-'));
    writeCandles(candles);
    return { w, data, candles, engineKey: loadOrCreateKey(join(w.home, 'engine.key')) };
  })();
  return built;
}

async function run(args, extra = {}) {
  const out = [];
  const err = [];
  const io = { env: { LANG: 'en_US.UTF-8' }, out: (s) => out.push(s), err: (s) => err.push(s), now: () => TO + 10 * DAY, ...extra };
  const code = await main(['arena', 'recompute', ...args], io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** A copy of the published data to tamper with. */
async function copy() {
  const s = await season();
  const dir = mkdtempSync(join(tmpdir(), 'arena-data-copy-'));
  cpSync(s.data, dir, { recursive: true });
  return { ...s, dir };
}

const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const writeJson = (f, v) => writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`);

/** Find a result line in an agent's files; edit it with `fn(event)`, re-signed by the arena's key if `sign`. */
function editResult({ dir, engineKey }, agent, match, fn, { sign = true } = {}) {
  for (let d = FROM; d <= TO; d += DAY) {
    const f = join(dir, 'ledgers', agent, `${day(d)}.json`);
    let led;
    try { led = readJson(f); } catch { continue; }
    const i = led.results.findIndex((l) => match(JSON.parse(l)));
    if (i === -1) continue;
    const ev = JSON.parse(led.results[i]);
    const before = structuredClone(ev);
    fn(ev);
    const { sig, ...body } = ev;
    led.results[i] = canon(sign ? { ...body, sig: signText(engineKey, canon(body)) } : ev);
    writeJson(f, led);
    return before;
  }
  throw new Error('no such result line');
}

test('a clean season recomputes: every week and the season board match', async () => {
  const s = await season();
  const w44 = await run(['--data', s.data, '--candles', s.candles, '--week', '2026-W44']);
  assert.equal(w44.code, 0, w44.out + w44.err);
  assert.match(w44.out, /Everything matches/);
  assert.match(w44.out, /my-agent\s+.*OK/);
  assert.match(w44.out, /baseline-hold\s+.*OK/);
  const board = readJson(join(s.data, 'weekly/2026-W44.json'));
  assert.equal(board.rows.length, 4);
  assert.ok(board.rows.find((r) => r.agentId === 'my-agent').trades >= 2, 'the agent traded in the first week');

  const latest = await run(['--data', s.data, '--candles', s.candles]); // newest week by default
  assert.equal(latest.code, 0, latest.out);
  assert.match(latest.out, /Week 2026-W45/);
  const whole = await run(['--data', s.data, '--candles', s.candles, '--season', 'S1']);
  assert.equal(whole.code, 0, whole.out);
  assert.match(whole.out, /results: \d+ lines .* 1 one-line gap \(/, 'the week end between the two weeks is the only gap');

  const json = await run(['--data', s.data, '--candles', s.candles, '--json']);
  const rep = JSON.parse(json.out);
  assert.equal(rep.ok, true);
  assert.equal(rep.counts.requests, 0, 'offline: nothing downloaded');
  assert.ok(rep.counts.fills >= 10);
});

test('a fill price changed and re-signed by the arena: the recompute shows published vs recomputed', async () => {
  const c = await copy();
  const was = editResult(c, 'my-agent', (e) => e.type === 'fill' && e.data.symbol === 'ETHUSDT' && e.data.side === 'buy', (e) => { e.data.price = '2400.00000000'; });
  const r = await run(['--data', c.dir, '--candles', c.candles, '--week', '2026-W44']);
  assert.equal(r.code, 1);
  assert.match(r.out, /my-agent\s+.*MISMATCH/);
  assert.match(r.out, new RegExp(`order 0 outcome price: published 2400\\.00000000, recomputed ${was.data.price.replace('.', '\\.')}`));
  assert.match(r.out, /result chain broken at seq/, 'changing a line breaks the link from the next one');
  assert.match(r.out, /difference.* found/);
});

test('an order line changed after signing: the agent signature check fails', async () => {
  const c = await copy();
  const f = join(c.dir, 'ledgers/my-agent/2026-11-01.json');
  const led = readJson(f);
  led.orders[0].line = led.orders[0].line.replace('"usdt":"500.00000000"', '"usdt":"900.00000000"');
  writeJson(f, led);
  const r = await run(['--data', c.dir, '--candles', c.candles, '--week', '2026-W44']);
  assert.equal(r.code, 1);
  assert.match(r.out, /my-agent: \[orders\] order 0: signature does not match the agent's key/);
});

test('a broken chain: a missing order and a result whose link was rewritten', async () => {
  const c = await copy();
  const f = join(c.dir, 'ledgers/my-agent/2026-11-01.json');
  const led = readJson(f);
  led.orders.splice(1, 1); // drop order 1
  writeJson(f, led);
  editResult(c, 'baseline-dca', (e) => e.type === 'day' && e.data.date === '2026-11-02', (e) => { e.prev = 'f'.repeat(64); });
  const r = await run(['--data', c.dir, '--candles', c.candles, '--week', '2026-W45']);
  assert.equal(r.code, 1);
  assert.match(r.out, /my-agent: \[orders\] order chain broken: seq 1 missing/);
  assert.match(r.out, /baseline-dca: \[chain\] result chain broken at seq \d+: prev is not the hash/);
});

test('a result line dropped from the published ledger shows up as missing', async () => {
  const c = await copy();
  const f = join(c.dir, 'ledgers/baseline-hold/2026-11-01.json');
  const led = readJson(f);
  const i = led.results.findIndex((l) => JSON.parse(l).type === 'fill');
  led.results.splice(i, 1);
  writeJson(f, led);
  const r = await run(['--data', c.dir, '--candles', c.candles, '--week', '2026-W44']);
  assert.equal(r.code, 1);
  assert.match(r.out, /baseline-hold: \[results\] order 0 outcome: the recompute made a fill that is not in the published ledger/);
});

test('a wrong score on the board: which row, which field, both numbers', async () => {
  const c = await copy();
  const f = join(c.dir, 'weekly/2026-W44.json');
  const board = readJson(f);
  const row = board.rows.find((r) => r.agentId === 'my-agent');
  const real = row.score;
  row.score = real + 1;
  writeJson(f, board);
  const r = await run(['--data', c.dir, '--candles', c.candles, '--week', '2026-W44']);
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`my-agent\\s+.*MISMATCH  score: published ${real + 1}, recomputed ${real}`));
  assert.match(r.out, /baseline-hold\s+.*OK/, 'the other rows still say OK');
});

test('cannot recompute: no arena key, or candles missing offline (exit 2, not a mismatch)', async () => {
  const c = await copy();
  writeJson(join(c.dir, 'config.json'), { arenaKey: '' });
  const nokey = await run(['--data', c.dir, '--candles', c.candles]);
  assert.equal(nokey.code, 2);
  assert.match(nokey.err, /arena's public key is unknown/);
  const empty = mkdtempSync(join(tmpdir(), 'no-candles-'));
  const nocandles = await run(['--data', c.data, '--candles', empty]);
  assert.equal(nocandles.code, 2);
  assert.match(nocandles.err, /no candles for BTCUSDT 1m 2026-11-01/);
});

test('online: candles come from the (fake) Binance public API once, inside the budget, then from disk', async () => {
  const s = await season();
  const cache = mkdtempSync(join(tmpdir(), 'candle-cache-'));
  const clock = { t: TO + 10 * DAY };
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push({ url, t: clock.t, ua: init?.headers?.['user-agent'] });
    s.w.clock.t = clock.t;
    return s.w.fetchImpl(url, init);
  };
  const extra = { fetch: fetchImpl, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } };
  const r = await run(['--data', s.data, '--cache', cache, '--season', 'S1'], extra);
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(asked.every((a) => new URL(a.url).host === 'data-api.binance.vision'));
  assert.ok(asked.every((a) => /^tal-recompute\//.test(a.ua)));
  // 2 days × 1,440 minutes = 3 requests of ≤ 1,000 per symbol, plus 1 for the daily closes.
  assert.equal(asked.length, 6 * 3 + 1);
  for (const a of asked) assert.ok(asked.filter((b) => b.t > a.t - 60_000 && b.t <= a.t).length <= 12, 'at most 12 in any 60 s');
  const again = await run(['--data', s.data, '--cache', cache, '--season', 'S1', '--json'], extra);
  assert.equal(again.code, 0);
  assert.equal(JSON.parse(again.out).counts.requests, 0, 'second time: all from disk');
  assert.equal(asked.length, 19);
});
