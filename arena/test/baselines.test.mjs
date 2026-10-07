import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { publicRaw } from '../../guard/src/keys.js';
import { newBook } from '../../guard/src/book.js';
import { parse } from '../../guard/src/money.js';
import { BASELINES, baselineOrders } from '../src/baselines.js';
import { Arena, MINUTE } from '../src/engine.js';
import { makeOrder } from '../src/orders.js';
import { validateStandings } from '../src/standings.js';
import { API, T0, world } from './world.mjs';

const DAY = 86_400_000;
const closes = { BTCUSDT: parse('65000'), ETHUSDT: parse('2500'), SOLUSDT: parse('150') };

test('hold: on its first minute, buys BTC, ETH, SOL up to just under 30% each, then nothing', () => {
  const book = newBook(parse('10000'));
  const o = baselineOrders({ kind: 'baseline-hold', m: T0, startedAt: T0, book, closes, equity: parse('10000') });
  assert.deepEqual([...new Set(o.map((x) => x.symbol))], ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  for (const x of o) assert.ok(Number(x.usdt) <= 990);
  const per = (s) => o.filter((x) => x.symbol === s).reduce((a, x) => a + Number(x.usdt), 0);
  assert.ok(per('BTCUSDT') > 2850 && per('BTCUSDT') <= 2900);
  assert.deepEqual(baselineOrders({ kind: 'baseline-hold', m: T0 + MINUTE, startedAt: T0, book, closes, equity: parse('10000') }), []);
});

test('daily DCA: 1% each of BTC and ETH at 00:00 UTC only', () => {
  const book = newBook(parse('10000'));
  const o = baselineOrders({ kind: 'baseline-dca', m: T0 + DAY, startedAt: T0, book, closes, equity: parse('10000') });
  assert.deepEqual(o.map((x) => [x.symbol, x.usdt]), [['BTCUSDT', '100.00'], ['ETHUSDT', '100.00']]);
  assert.deepEqual(baselineOrders({ kind: 'baseline-dca', m: T0 + DAY + MINUTE, startedAt: T0, book, closes, equity: parse('10000') }), []);
});

test('20-day average: buys when the last close is above it, sells everything when below, waits without data', () => {
  const book = newBook(parse('10000'));
  const up = Array.from({ length: 20 }, (_, i) => String(60000 + i * 100));
  const down = Array.from({ length: 20 }, (_, i) => String(70000 - i * 100));
  const buy = baselineOrders({ kind: 'baseline-ma', m: T0 + DAY, startedAt: T0, book, closes, equity: parse('10000'), daily: () => up });
  assert.ok(buy.length >= 2 && buy.every((x) => x.side === 'buy' && x.symbol === 'BTCUSDT'));
  book.pos.BTCUSDT = parse('0.04');
  const sell = baselineOrders({ kind: 'baseline-ma', m: T0 + DAY, startedAt: T0, book, closes, equity: parse('10000'), daily: () => down });
  assert.deepEqual(sell.map((x) => [x.side, x.qty]), [['sell', 'all']]);
  assert.deepEqual(baselineOrders({ kind: 'baseline-ma', m: T0 + DAY, startedAt: T0, book, closes, equity: parse('10000'), daily: () => undefined }), []);
});

test('in the arena: baselines fill under the same locks, are marked official, and nobody can trade for them', () => {
  const arena = new Arena({ season: { id: 'S1', from: T0, to: T0 + 30 * DAY } });
  for (const id of Object.keys(BASELINES)) arena.addBaseline(id, T0);
  const px = { BTCUSDT: '65000', ETHUSDT: '2500', SOLUSDT: '150', BNBUSDT: '600', XRPUSDT: '0.6', DOGEUSDT: '0.12' };
  const candles = { open: (s) => px[s], close: (s) => px[s], daily: () => Array.from({ length: 20 }, (_, i) => String(60000 + i * 100)) };
  const ev = arena.advance(T0 + 5 * MINUTE, candles);
  assert.ok(ev.filter((e) => e.type === 'fill' && e.agent === 'baseline-hold').length >= 9);
  assert.equal(ev.filter((e) => e.type === 'reject').length, 0, 'no lock refuses a baseline order');
  const hold = arena.agents['baseline-hold'];
  const btcPct = Number((hold.book.pos.BTCUSDT * 65000n) / 10n ** 8n) / 100;
  assert.ok(btcPct > 28 && btcPct < 30, `BTC ${btcPct}%`);
  const doc = arena.standings('week', { source: 'test' });
  assert.deepEqual(validateStandings(doc), []);
  assert.ok(doc.rows.every((r) => r.official === true));
  const { privateKey } = generateKeyPairSync('ed25519');
  const forged = makeOrder({ key: privateKey, agent: 'baseline-hold', now: T0 + 6 * MINUTE, symbol: 'BTCUSDT', side: 'sell', qty: 'all', reason: 'x' });
  assert.equal(arena.receive({ line: forged.line, recv: T0 + 6 * MINUTE })[0].rule, 'bad_signature');
  assert.throws(() => arena.addAgent({ agentId: 'baseline-dca', name: 'X', model: 'Y', pubkey: publicRaw(privateKey), joined: T0 }), /reserved|already/);
});

test('end to end: the engine loop runs the baselines and the board shows them', async () => {
  const w = world({ roster: [], baselines: ['baseline-hold', 'baseline-dca', 'baseline-ma'] });
  w.clock.t = T0 + 3 * MINUTE + 25_000;
  await w.loop.once();
  const board = await (await w.fetchImpl(`${API}/standings/latest.json`)).json();
  assert.deepEqual(board.rows.map((r) => r.agentId).sort(), ['baseline-dca', 'baseline-hold', 'baseline-ma']);
  assert.ok(board.rows.find((r) => r.agentId === 'baseline-hold').trades >= 9);
  const agents = await (await w.fetchImpl(`${API}/agents.json`)).json();
  assert.ok(agents.agents.every((a) => a.official === true));
});
