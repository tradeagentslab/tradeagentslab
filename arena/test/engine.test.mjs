import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { publicRaw } from '../../guard/src/keys.js';
import { GENESIS } from '../../guard/src/ledger.js';
import { Arena, checkAgent, isoWeek, isoWeekById, MINUTE, pct2 } from '../src/engine.js';
import { makeOrder } from '../src/orders.js';
import { validateStandings } from '../src/standings.js';

const T0 = Date.parse('2026-10-28T00:00:00Z');
const SEASON = { id: 'S1', from: T0, to: Date.parse('2026-12-01T00:00:00Z') };

// Candles you set by hand: one price per symbol, overridable per minute.
function market() {
  const px = { BTCUSDT: '65000', ETHUSDT: '2500', SOLUSDT: '150', BNBUSDT: '600', XRPUSDT: '0.6', DOGEUSDT: '0.12' };
  const at = {};
  return {
    px,
    at,
    open: (s, m) => at[`${s}@${m}`] ?? px[s],
    close: (s, m) => at[`${s}@${m}`] ?? px[s],
  };
}

function agent(id) {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { id, key: privateKey, pub: publicRaw(privateKey), state: { seq: -1, hash: GENESIS } };
}

function send(arena, ag, now, order) {
  const { line, next } = makeOrder({ key: ag.key, agent: ag.id, state: ag.state, now, ...order });
  const ev = arena.receive({ line, recv: now });
  if (ev[0].type !== 'reject' || !['bad_signature', 'bad_chain', 'bad_input', 'unknown_agent', 'bad_time'].includes(ev[0].rule)) ag.state = next;
  return ev;
}

function setup() {
  const arena = new Arena({ season: SEASON });
  const a = agent('tal-a');
  const b = agent('tal-b');
  arena.addAgent({ agentId: a.id, name: 'A', model: 'Model A', official: true, pubkey: a.pub, joined: T0 });
  arena.addAgent({ agentId: b.id, name: 'B', model: 'Model B', official: false, pubkey: b.pub, joined: T0 });
  return { arena, a, b, mk: market() };
}

test('an order fills at the open of the next minute, under the guard\'s locks', () => {
  const { arena, a, mk } = setup();
  arena.advance(T0 + 30_000, mk);
  const r = send(arena, a, T0 + 30_000, { symbol: 'BTCUSDT', side: 'buy', usdt: 1000, reason: 'first trade' });
  assert.equal(r[0].type, 'recv');
  assert.equal(r[0].fill_minute, '2026-10-28T00:01:00.000Z');
  mk.at[`BTCUSDT@${T0 + MINUTE}`] = '64000';
  const ev = arena.advance(T0 + 2 * MINUTE + 5000, mk);
  const fill = ev.find((e) => e.type === 'fill');
  assert.equal(fill.price, '64000.00000000');
  assert.equal(fill.qty, '0.01562500');
  assert.equal(fill.reason, 'first trade');
  assert.equal(arena.agents['tal-a'].book.pos.BTCUSDT, 1562500n);
});

test('signatures, chains and clocks are checked on arrival', () => {
  const { arena, a, b, mk } = setup();
  arena.advance(T0 + 30_000, mk);
  const forged = makeOrder({ key: b.key, agent: a.id, state: a.state, now: T0 + 30_000, symbol: 'BTCUSDT', side: 'buy', usdt: 100, reason: 'x' });
  assert.equal(arena.receive({ line: forged.line, recv: T0 + 30_000 })[0].rule, 'bad_signature');
  const skip = makeOrder({ key: a.key, agent: a.id, state: { seq: 5, hash: GENESIS }, now: T0 + 30_000, symbol: 'BTCUSDT', side: 'buy', usdt: 100, reason: 'x' });
  assert.equal(arena.receive({ line: skip.line, recv: T0 + 30_000 })[0].rule, 'bad_chain');
  const late = makeOrder({ key: a.key, agent: a.id, state: a.state, now: T0, symbol: 'BTCUSDT', side: 'buy', usdt: 100, reason: 'x' });
  assert.equal(arena.receive({ line: late.line, recv: T0 + 10 * MINUTE })[0].rule, 'bad_time');
  const tampered = JSON.parse(makeOrder({ key: a.key, agent: a.id, state: a.state, now: T0 + 30_000, symbol: 'BTCUSDT', side: 'buy', usdt: 100, reason: 'x' }).line);
  tampered.usdt = '900.00000000';
  assert.ok(['bad_signature', 'bad_input'].includes(arena.receive({ line: JSON.stringify(tampered), recv: T0 + 30_000 })[0].rule));
  assert.equal(arena.receive({ line: '{"agent":"nobody"}', recv: T0 })[0].rule, 'unknown_agent');
  // a good one still goes through after all that
  assert.equal(send(arena, a, T0 + 30_000, { symbol: 'BTCUSDT', side: 'buy', usdt: 100, reason: 'ok' })[0].type, 'recv');
});

test('locks apply at the fill minute: too big, not listed, no position', () => {
  const { arena, a, mk } = setup();
  arena.advance(T0 + 30_000, mk);
  send(arena, a, T0 + 30_000, { symbol: 'BTCUSDT', side: 'buy', usdt: 1001, reason: 'too big' });
  send(arena, a, T0 + 31_000, { symbol: 'PEPEUSDT', side: 'buy', usdt: 100, reason: 'not listed' });
  send(arena, a, T0 + 32_000, { symbol: 'ETHUSDT', side: 'sell', qty: 1, reason: 'nothing to sell' });
  const ev = arena.advance(T0 + 2 * MINUTE + 5000, mk);
  assert.deepEqual(ev.filter((e) => e.type === 'reject').map((e) => e.rule), ['max_order', 'symbol', 'no_position']);
});

test('equity at 70% of the start (a 30% loss) puts an agent out for the season', () => {
  const { arena, a, mk } = setup();
  arena.advance(T0 + 30_000, mk);
  let t = T0 + 30_000;
  for (const s of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
    for (let i = 0; i < 3; i++) send(arena, a, (t += 1000), { symbol: s, side: 'buy', usdt: 990, reason: 'load up' });
  }
  arena.advance(T0 + 2 * MINUTE + 5000, mk);
  // a 35% drop on 89% invested ≈ a 31% loss (each order is 990: 1,000 would break the 10% lock once fees shave equity)
  mk.px.BTCUSDT = '42250';
  mk.px.ETHUSDT = '1625';
  mk.px.SOLUSDT = '97.5';
  const ev = arena.advance(T0 + 3 * MINUTE + 5000, mk);
  assert.equal(ev.find((e) => e.type === 'out')?.agent, 'tal-a');
  assert.equal(arena.agents['tal-a'].status, 'out');
  const r = send(arena, a, T0 + 3 * MINUTE + 10_000, { symbol: 'BTCUSDT', side: 'sell', qty: 'all', reason: 'too late' });
  assert.equal(r[0].rule, 'out');
});

test('marks every hour; standings validate and rank by score', () => {
  const { arena, a, b, mk } = setup();
  arena.advance(T0 + 30_000, mk);
  send(arena, a, T0 + 30_000, { symbol: 'SOLUSDT', side: 'buy', usdt: 1000, reason: 'a' });
  send(arena, b, T0 + 40_000, { symbol: 'DOGEUSDT', side: 'buy', usdt: 1000, reason: 'b' });
  arena.advance(T0 + 2 * MINUTE + 5000, mk);
  mk.px.SOLUSDT = '165'; // +10% on 1,000 → about +1%
  mk.px.DOGEUSDT = '0.108'; // -10% → about -1%
  const ev = arena.advance(T0 + 2 * 60 * MINUTE + 5000, mk);
  assert.equal(ev.filter((e) => e.type === 'mark').length, 4, 'two hours × two agents');
  const doc = arena.standings('week', { source: 'test' });
  assert.deepEqual(validateStandings(doc), []);
  assert.deepEqual(doc.rows.map((r) => r.agentId), ['tal-a', 'tal-b']);
  assert.ok(doc.rows[0].returnPct > 0.9 && doc.rows[0].returnPct < 1);
  assert.ok(doc.rows[1].maxDrawdownPct > 0.9);
  assert.equal(doc.period.id, '2026-W44');
  assert.equal(doc.rows[0].curve.length, 3, 'start, 01:00, 02:00');
});

test('same inputs, same outputs; saving and loading changes nothing', () => {
  const run = (split) => {
    const arena = new Arena({ season: SEASON });
    const mk = market();
    const ag = { id: 'tal-x', key: KEY, pub: PUB, state: { seq: -1, hash: GENESIS } };
    arena.addAgent({ agentId: 'tal-x', name: 'X', model: 'M', official: false, pubkey: PUB, joined: T0 });
    let box = arena;
    const out = [];
    out.push(...box.advance(T0 + 30_000, mk));
    out.push(...send(box, ag, T0 + 30_000, { symbol: 'ETHUSDT', side: 'buy', usdt: 500, reason: 'r1' }));
    out.push(...box.advance(T0 + 2 * MINUTE + 5000, mk)); // the buy fills at 2,500
    if (split) box = Arena.fromJSON(JSON.parse(JSON.stringify(box.toJSON())));
    mk.px.ETHUSDT = '2600';
    out.push(...box.advance(T0 + 70 * MINUTE, mk));
    out.push(...send(box, ag, T0 + 70 * MINUTE, { symbol: 'ETHUSDT', side: 'sell', qty: 'all', reason: 'r2' }));
    out.push(...box.advance(T0 + 75 * MINUTE, mk));
    return { out: out.map(({ order, ...e }) => e), rows: box.rows('season') };
  };
  const one = run(false);
  const two = run(true);
  assert.deepEqual(two, one);
  const sell = one.out.find((e) => e.type === 'fill' && e.side === 'sell');
  assert.ok(Number(sell.pnl_usdt) > 18 && Number(sell.pnl_usdt) < 20, 'bought at 2500, sold at 2600, less fees');
});

const { privateKey: KEY } = generateKeyPairSync('ed25519');
const PUB = publicRaw(KEY);

test('missing candles: the engine waits, then catches up minute by minute', () => {
  const { arena, a, mk } = setup();
  arena.advance(T0 + 30_000, mk);
  send(arena, a, T0 + 30_000, { symbol: 'ETHUSDT', side: 'buy', usdt: 100, reason: 'x' });
  const gap = { open: () => undefined, close: () => undefined };
  assert.deepEqual(arena.advance(T0 + 5 * MINUTE, gap), []);
  const ev = arena.advance(T0 + 5 * MINUTE, mk);
  assert.equal(ev.filter((e) => e.type === 'fill').length, 1);
  assert.equal(arena.minute, T0 + 4 * MINUTE);
});

test('helpers: percent rounding and ISO weeks', () => {
  assert.equal(pct2(312n, 10000n), 3.12);
  assert.equal(pct2(-85n, 10000n), -0.85);
  assert.equal(pct2(1n, 3n), 33.33);
  assert.equal(pct2(2n, 3n), 66.67);
  assert.equal(pct2(-2n, 3n), -66.67);
  assert.equal(isoWeek(T0).id, '2026-W44');
  assert.equal(new Date(isoWeek(T0).from).toISOString(), '2026-10-26T00:00:00.000Z');
  assert.equal(isoWeek(Date.parse('2027-01-01T12:00:00Z')).id, '2026-W53');
});

test('a finished week is closed with its board and the best and worst trade', () => {
  const { arena, a, b, mk } = setup();
  const sun = Date.parse('2026-11-01T23:00:00Z');
  arena.advance(T0 + 30_000, mk);
  send(arena, a, T0 + 30_000, { symbol: 'SOLUSDT', side: 'buy', usdt: 900, reason: 'a in' });
  send(arena, b, T0 + 31_000, { symbol: 'XRPUSDT', side: 'buy', usdt: 900, reason: 'b in, chasing a signal' });
  arena.advance(T0 + 2 * MINUTE + 25_000, mk);
  mk.px.SOLUSDT = '170';
  mk.px.XRPUSDT = '0.5';
  arena.advance(sun, mk);
  send(arena, a, sun, { symbol: 'SOLUSDT', side: 'sell', qty: 'all', reason: 'a out with a gain' });
  send(arena, b, sun + 1000, { symbol: 'XRPUSDT', side: 'sell', qty: 'all', reason: 'b out with a loss' });
  const ev = arena.advance(Date.parse('2026-11-02T00:05:00Z'), mk);
  assert.ok(ev.some((e) => e.type === 'week_end' && e.week === '2026-W44'));
  const wk = arena.closed.find((c) => c.kind === 'week');
  assert.equal(wk.id, '2026-W44');
  assert.equal(wk.highlights.bestTrade.agentId, 'tal-a');
  assert.equal(wk.highlights.worstTrade.agentId, 'tal-b');
  const doc = arena.standings('week', { source: 'test', closed: wk });
  assert.deepEqual(validateStandings(doc), []);
  assert.equal(doc.period.from, '2026-10-28T00:00:00.000Z', 'week 44 starts with the season');
  assert.equal(doc.period.to, '2026-11-02T00:00:00.000Z');
  assert.deepEqual(doc.rows.map((r) => r.agentId), ['tal-a', 'tal-b']);
  const live = arena.standings('week', { source: 'test' });
  assert.equal(live.period.id, '2026-W45');
});

test('reasons with words the videos refuse are not shown in highlights', () => {
  const { arena, a, mk } = setup();
  arena.advance(T0 + 30_000, mk);
  send(arena, a, T0 + 30_000, { symbol: 'ETHUSDT', side: 'buy', usdt: 500, reason: 'in' });
  arena.advance(T0 + 2 * MINUTE + 25_000, mk);
  send(arena, a, T0 + 3 * MINUTE, { symbol: 'ETHUSDT', side: 'sell', qty: 'all', reason: 'this is a guaranteed win' });
  arena.advance(T0 + 5 * MINUTE, mk);
  const doc = arena.standings('week', { source: 'test' });
  assert.match(doc.highlights.bestTrade.reason, /not shown/);
});

test('names and models must be showable', () => {
  const pub = publicRaw(generateKeyPairSync('ed25519').privateKey);
  assert.throws(() => checkAgent({ agentId: 'ok-id', name: 'SignalBot', model: 'm', pubkey: pub }), /name/);
  assert.throws(() => checkAgent({ agentId: 'ok-id', name: 'n', model: '稳赚模型', pubkey: pub }), /model/);
  assert.throws(() => checkAgent({ agentId: 'Bad_ID', name: 'n', model: 'm', pubkey: pub }), /agentId/);
  assert.throws(() => checkAgent({ agentId: 'ok-id', name: 'n', model: 'm', pubkey: 'abc' }), /pubkey/);
  checkAgent({ agentId: 'ok-id', name: 'Claude', model: 'Claude Opus 5.5', pubkey: pub });
});

test('an order that reaches the engine after its minute was settled is refused as late', () => {
  const { arena, a, mk } = setup();
  arena.advance(T0 + 10 * MINUTE, mk);
  const r = send(arena, a, T0 + 5 * MINUTE, { symbol: 'ETHUSDT', side: 'buy', usdt: 100, reason: 'slow pipe' });
  assert.equal(r[0].rule, 'late');
});

test('the season ends on time: final week and season boards, no orders after', () => {
  const short = { id: 'S0', from: T0, to: T0 + 3 * 60 * MINUTE };
  const arena = new Arena({ season: short });
  const a = agent('tal-a');
  arena.addAgent({ agentId: a.id, name: 'A', model: 'M', pubkey: a.pub, joined: T0 });
  const mk = market();
  const ev = arena.advance(T0 + 5 * 60 * MINUTE, mk);
  assert.ok(ev.some((e) => e.type === 'season_end'));
  assert.deepEqual(arena.closed.map((c) => c.kind), ['week', 'season']);
  assert.equal(arena.minute, short.to - MINUTE);
  const r = send(arena, a, short.to + MINUTE, { symbol: 'ETHUSDT', side: 'buy', usdt: 100, reason: 'too late' });
  assert.ok(['closed', 'late'].includes(r[0].rule));
});

test('account view: what the agent decides from', () => {
  const { arena, a, mk } = setup();
  arena.advance(T0 + 30_000, mk);
  send(arena, a, T0 + 30_000, { symbol: 'ETHUSDT', side: 'buy', usdt: 500, reason: 'in' });
  arena.advance(T0 + 2 * MINUTE + 25_000, mk);
  const v = arena.accountView('tal-a', T0 + 2 * MINUTE + 25_000);
  assert.equal(v.positions[0].symbol, 'ETHUSDT');
  assert.equal(v.positions[0].qty, '0.2');
  assert.equal(v.ordersLeft.thisHour, 11);
  assert.equal(v.today.buysAllowed, true);
  assert.equal(v.lastSeq, 0);
});

test('ISO week ids go both ways', () => {
  for (const id of ['2026-W44', '2026-W53', '2027-W01']) assert.equal(isoWeek(isoWeekById(id).from + 3600_000).id, id);
});
