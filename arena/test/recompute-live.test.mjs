// `tal arena recompute --live`: the running week's board (standings/latest), checked
// mid-season up to its asOf. A short S0-like season runs through the real engine loop
// and Worker (world.mjs). The live board is copied, then the engine runs on a few more
// minutes before the ledgers are copied, as happens for real: the ledger copy then holds
// lines from after asOf (the minute in progress), which must not count as differences.

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
const FROM = Date.parse('2026-10-21T00:00:00Z'); // a Wednesday, like S0
const TO = Date.parse('2026-10-27T00:00:00Z');
const CUT1 = Date.parse('2026-10-22T06:00:00Z'); // Thursday: first week, no weekly board yet
const CUT2 = Date.parse('2026-10-26T06:00:00Z'); // Monday: second week, 2026-W43 is closed
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const writeJson = (f, v) => {
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`);
};

function writeCandles(dir, upto) {
  for (const s of SYMBOLS) {
    mkdirSync(join(dir, s, '1m'), { recursive: true });
    for (let d = FROM; d < upto; d += DAY) {
      const rows = [];
      for (let t = d; t < d + DAY; t += MINUTE) rows.push([t, price(s, t), price(s, t), price(s, t), price(s, t + MINUTE - 1), '1']);
      writeFileSync(join(dir, s, '1m', `${day(d)}.json`), JSON.stringify(rows));
    }
  }
  mkdirSync(join(dir, 'BTCUSDT', '1d'), { recursive: true });
  for (let d = FROM - 20 * DAY; d < upto; d += DAY) {
    const p = price('BTCUSDT', d);
    writeFileSync(join(dir, 'BTCUSDT', '1d', `${day(d)}.json`), JSON.stringify([[d, p, p, p, price('BTCUSDT', d + DAY - 1), '1']]));
  }
}

let built;
function season() {
  built ??= (async () => {
    const w = world({
      season: { id: 'S0', from: FROM, to: TO },
      baselines: ['baseline-hold', 'baseline-dca', 'baseline-ma'],
      roster: (pubkey) => [{ agentId: 'my-agent', name: 'My Agent', model: 'Model X 1.0', pubkey, joined: '2026-10-21T00:00:00Z' }],
    });
    await w.catchUp(200);
    let state = { seq: -1, hash: GENESIS };
    const send = async (t, o) => {
      w.clock.t = Math.max(w.clock.t, t);
      const { line, next } = makeOrder({ key: w.agentKey, agent: 'my-agent', now: w.clock.t, state, ...o });
      const res = await w.fetchImpl(`${API}/orders`, { method: 'POST', body: line });
      assert.equal(res.status, 201);
      state = next;
    };
    const candles = mkdtempSync(join(tmpdir(), 'candles-live-'));
    writeCandles(candles, TO);
    const engineKey = loadOrCreateKey(join(w.home, 'engine.key'));

    /** Run to `cut`, copy the live board, run 3 more minutes, then copy the rest (as snapshot.mjs --live does). */
    const snapshotAt = async (cut, ordersBefore) => {
      for (const [t, o] of ordersBefore) {
        await send(t, o);
        await w.catchUp(200);
      }
      // Catch up to just before the cut first (catching up moves the clock on a little).
      w.clock.t = Math.max(w.clock.t, cut - 15 * MINUTE);
      await w.catchUp(200);
      w.clock.t = Math.max(w.clock.t, cut - 2 * MINUTE);
      await w.catchUp(200);
      assert.ok(w.clock.t < cut - 10_000);
      // An order in the last minute before the cut: taken before asOf, filled at asOf (in progress).
      await send(cut - 10_000, { symbol: 'BTCUSDT', side: 'buy', usdt: 100, reason: 'at the edge' });
      w.clock.t = cut + 25_000; // the engine settles a minute 20 s after it ends: the board is as of `cut`
      await w.catchUp(200);
      const latest = await w.get('/standings/latest.json');
      assert.equal(latest.asOf, new Date(cut).toISOString(), 'the board is as of the cut');
      // And one taken after asOf, then the engine runs on before the ledgers are copied.
      await send(cut + 30_000, { symbol: 'ETHUSDT', side: 'buy', usdt: 50, reason: 'after the cut' });
      w.clock.t = cut + 3 * MINUTE + 25_000;
      await w.catchUp(200);

      const data = mkdtempSync(join(tmpdir(), 'arena-live-'));
      writeJson(join(data, 'standings/latest.json'), latest);
      const agents = await w.get('/agents.json');
      writeJson(join(data, 'agents.json'), agents);
      for (let d = FROM; d <= cut; d += DAY) {
        const id = `2026-W${43 + Math.floor((d - Date.parse('2026-10-19T00:00:00Z')) / (7 * DAY))}`;
        const wk = await (await w.fetchImpl(`${API}/weekly/${id}.json`)).json();
        if (wk.rows) writeJson(join(data, `weekly/${id}.json`), wk);
      }
      for (const a of agents.agents) {
        for (let d = FROM; d <= cut + DAY; d += DAY) {
          const led = await w.get(`/ledger/${a.agentId}/${day(d)}.json`);
          if (led.orders.length || led.results.length) writeJson(join(data, `ledgers/${a.agentId}/${day(d)}.json`), led);
        }
      }
      return data;
    };
    const live1 = await snapshotAt(CUT1, [
      [FROM + 30_000, { symbol: 'ETHUSDT', side: 'buy', usdt: 500, reason: 'first look' }],
      [FROM + 20 * HOUR + 40_000, { symbol: 'ETHUSDT', side: 'sell', qty: 'all', reason: 'take it off' }],
    ]);
    const live2 = await snapshotAt(CUT2, [
      [Date.parse('2026-10-25T12:00:15Z'), { symbol: 'SOLUSDT', side: 'buy', usdt: 300, reason: 'weekend' }],
    ]);
    return { w, candles, engineKey, live1, live2 };
  })();
  return built;
}

async function run(args) {
  const out = [];
  const err = [];
  const io = { env: { LANG: 'en_US.UTF-8' }, out: (s) => out.push(s), err: (s) => err.push(s), now: () => CUT2 + DAY };
  const code = await main(['arena', 'recompute', ...args], io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const key = async () => (await season()).w.loop.pubkey();

function copyOf(dir) {
  const c = mkdtempSync(join(tmpdir(), 'arena-live-copy-'));
  cpSync(dir, c, { recursive: true });
  return c;
}

/** Edit the first result line (any agent, any day) matching `match`, re-signed by the arena's key. */
function editResult(dir, engineKey, agent, match, fn) {
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
    led.results[i] = canon({ ...body, sig: signText(engineKey, canon(body)) });
    writeJson(f, led);
    return before;
  }
  throw new Error('no such result line');
}

test('mid-season live board, first week: everything before asOf matches', async () => {
  const s = await season();
  const r = await run(['--data', s.live1, '--candles', s.candles, '--arena-key', await key(), '--live']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /Live board 2026-W43 as of 2026-10-22T06:00:00\.000Z/);
  assert.match(r.out, /my-agent\s+.*OK/);
  assert.match(r.out, /baseline-ma\s+.*OK/);
  assert.match(r.out, /Everything matches/);
});

test('mid-season live board, second week: season start from the closed week, still matches', async () => {
  const s = await season();
  const r = await run(['--data', s.live2, '--candles', s.candles, '--arena-key', await key(), '--live', '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  const rep = JSON.parse(r.out);
  assert.equal(rep.kind, 'live');
  assert.equal(rep.id, '2026-W44');
  assert.equal(rep.season.from, '2026-10-21T00:00:00.000Z');
  assert.equal(rep.asOf, '2026-10-26T06:00:00.000Z');
  assert.equal(rep.counts.minutes, (CUT2 - FROM) / MINUTE);
});

test('the minute in progress at asOf: in the ledger copy, but not compared', async () => {
  const s = await season();
  const files = (agent) => [day(CUT1)].map((d) => readJson(join(s.live1, `ledgers/${agent}/${d}.json`)));
  const lines = files('my-agent').flatMap((l) => l.results.map((x) => JSON.parse(x)));
  const edge = lines.find((e) => e.type === 'fill' && e.data.minute === new Date(CUT1).toISOString());
  assert.ok(edge, 'the order taken just before asOf filled at asOf, and that fill is in the copy');
  assert.ok(lines.some((e) => e.type === 'recv' && Date.parse(e.data.recv) >= CUT1), 'an order taken after asOf is in the copy');
  const board = readJson(join(s.live1, 'standings/latest.json'));
  assert.equal(board.rows.find((r) => r.agentId === 'my-agent').trades, 2, 'the board does not count the fill at asOf');

  // Tampering after the cut is out of scope: no difference.
  const c = copyOf(s.live1);
  editResult(c, s.engineKey, 'my-agent', (e) => e.type === 'fill' && e.data.minute === new Date(CUT1).toISOString(), (e) => { e.data.price = '1.00000000'; });
  const r = await run(['--data', c, '--candles', s.candles, '--arena-key', await key(), '--live']);
  assert.ok(!/order 2 outcome price/.test(r.out), r.out);
  // (Only the chain notices it: the next line's link no longer matches. Chains are checked over the whole copy.)
  assert.match(r.out, /\[chain\] result chain broken/);
});

test('a result line before asOf changed and re-signed: caught', async () => {
  const s = await season();
  const c = copyOf(s.live1);
  const was = editResult(c, s.engineKey, 'my-agent', (e) => e.type === 'fill' && e.data.symbol === 'ETHUSDT' && e.data.side === 'buy', (e) => { e.data.price = '2400.00000000'; });
  const r = await run(['--data', c, '--candles', s.candles, '--arena-key', await key(), '--live']);
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`order 0 outcome price: published 2400\\.00000000, recomputed ${was.data.price.replace('.', '\\.')}`));
});

test('a wrong field on the live board: caught', async () => {
  const s = await season();
  const c = copyOf(s.live1);
  const f = join(c, 'standings/latest.json');
  const board = readJson(f);
  const row = board.rows.find((x) => x.agentId === 'baseline-hold');
  row.maxDrawdownPct += 0.5;
  writeJson(f, board);
  const r = await run(['--data', c, '--candles', s.candles, '--arena-key', await key(), '--live']);
  assert.equal(r.code, 1);
  assert.match(r.out, /baseline-hold\s+.*MISMATCH  maxDrawdownPct: published/);
});

test('--live needs the live board, and does not mix with --week or --season', async () => {
  const s = await season();
  const none = await run(['--data', mkdtempSync(join(tmpdir(), 'nolive-')), '--arena-key', await key(), '--live']);
  assert.equal(none.code, 2);
  const c = copyOf(s.live1);
  const nolatest = mkdtempSync(join(tmpdir(), 'nolive-'));
  cpSync(join(c, 'agents.json'), join(nolatest, 'agents.json'));
  const r = await run(['--data', nolatest, '--arena-key', await key(), '--live']);
  assert.equal(r.code, 2);
  assert.match(r.err, /no standings\/latest\.json/);
  const mixed = await run(['--data', c, '--arena-key', await key(), '--live', '--week', '2026-W43']);
  assert.equal(mixed.code, 2);
  assert.match(mixed.err, /leave out --week and --season/);
});
