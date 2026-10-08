import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildPrompt, cleanDecision, cliCommand, decisionSchema, parseDecision, publicKeys, runAll } from '../runner/run.mjs';
import { API, T0, world } from './world.mjs';

const AGENTS = [
  { agentId: 'tal-claude', name: 'Claude', cli: 'claude', model: 'model-c' },
  { agentId: 'tal-codex', name: 'Codex', cli: 'codex', model: 'model-x' },
  { agentId: 'tal-grok', name: 'Grok', cli: 'grok', model: 'model-g' },
];

// Fake CLIs: each answers in its own wrapper, like the real ones do.
function fakeExec(answers, seen = []) {
  return (bin, args) => {
    seen.push([bin, ...args]);
    const a = answers[bin];
    if (a === 'crash') return { status: 1, stdout: '', stderr: 'boom' };
    if (bin === 'claude') return { status: 0, stdout: JSON.stringify({ type: 'result', result: 'done', structured_output: a }) };
    if (bin === 'codex') {
      writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(a));
      return { status: 0, stdout: 'codex finished' };
    }
    return { status: 0, stdout: JSON.stringify({ result: `Here you go: ${JSON.stringify(a)}` }) };
  };
}

async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'runner-'));
  const config = { api: API, home, agents: AGENTS };
  const keys = publicKeys(config);
  const w = world({ roster: keys.map((k, i) => ({ ...k, name: AGENTS[i].name, model: AGENTS[i].model, official: true, joined: '2026-10-28T00:00:00Z' })) });
  w.clock.t = T0 + 6 * 60 * 60_000 + 5_000; // 06:00:05 UTC
  await w.catchUp(); // registers agents, catches up within the Binance budget, publishes snapshot and accounts
  return { w, config };
}

test('three CLIs, three wrappers, one decision format; orders reach the arena signed', async () => {
  const { w, config } = await setup();
  const seen = [];
  const exec = fakeExec({
    claude: { orders: [{ symbol: 'ETHUSDT', side: 'buy', usdt: 300, qty: null, reason: 'trend up on the 1h' }], note: 'small first step' },
    codex: { orders: [], note: 'holding: nothing clear' },
    grok: { orders: [{ symbol: 'SOLUSDT', side: 'buy', usdt: 200, qty: null, reason: 'bounce off the range low' }], note: 'one buy' },
  }, seen);
  const res = await runAll({ config, fetchImpl: w.fetchImpl, exec, now: () => w.clock.t, log: () => {} });
  assert.deepEqual(res.map((r) => r.posted?.length), [1, 0, 1]);
  assert.ok(res.every((r) => !r.error));
  assert.equal(res[0].posted[0].status, 201);

  // every CLI ran with tools and web search off
  const claude = seen.find((c) => c[0] === 'claude');
  assert.equal(claude[claude.indexOf('--tools') + 1], '');
  assert.ok(claude.includes('--strict-mcp-config'));
  const codex = seen.find((c) => c[0] === 'codex');
  assert.equal(codex[codex.indexOf('--sandbox') + 1], 'read-only');
  const grok = seen.find((c) => c[0] === 'grok');
  assert.ok(grok.includes('--disable-web-search'));

  // the engine fills them on its next rounds
  w.clock.t += 2 * 60_000 + 25_000;
  await w.loop.once();
  const board = await (await w.fetchImpl(`${API}/standings/latest.json`)).json();
  const trades = Object.fromEntries(board.rows.map((r) => [r.agentId, r.trades]));
  assert.deepEqual(trades, { 'tal-claude': 1, 'tal-codex': 0, 'tal-grok': 1 });
  assert.ok(existsSync(join(config.home, 'log', '2026-10-28.jsonl')));
});

test('one CLI failing does not stop the others; dry run posts nothing', async () => {
  const { w, config } = await setup();
  const exec = fakeExec({
    claude: 'crash',
    codex: { orders: [{ symbol: 'BTCUSDT', side: 'buy', usdt: 100, qty: null, reason: 'x' }], note: '' },
    grok: { orders: [], note: '' },
  });
  const res = await runAll({ config, fetchImpl: w.fetchImpl, exec, now: () => w.clock.t, log: () => {}, dryRun: true });
  assert.match(res[0].error, /exited 1/);
  assert.equal(res[1].posted[0].dryRun, true);
  const orders = await (await w.fetchImpl(`${API}/orders?after=0`)).json();
  assert.equal(orders.orders.length, 0);
});

test('a lost chain is picked up from the arena\'s answer', async () => {
  const { w, config } = await setup();
  const ok = fakeExec({ claude: { orders: [{ symbol: 'ETHUSDT', side: 'buy', usdt: 100, qty: null, reason: 'a' }], note: '' }, codex: { orders: [], note: '' }, grok: { orders: [], note: '' } });
  await runAll({ config, fetchImpl: w.fetchImpl, exec: ok, now: () => w.clock.t, log: () => {} });
  writeFileSync(join(config.home, 'keys', 'tal-claude.chain.json'), JSON.stringify({ seq: -1, hash: '0'.repeat(64) }));
  w.clock.t += 60_000;
  const res = await runAll({ config, fetchImpl: w.fetchImpl, exec: ok, now: () => w.clock.t, log: () => {}, only: 'tal-claude' });
  assert.equal(res[0].posted[0].status, 201);
  assert.equal(JSON.parse(readFileSync(join(config.home, 'keys', 'tal-claude.chain.json'), 'utf8')).seq, 1);
});

test('parse and clean: wrappers, junk, bad orders, too many orders', () => {
  const d = { orders: [{ symbol: 'ETHUSDT', side: 'buy', usdt: 1, qty: null, reason: 'r' }], note: 'n' };
  assert.deepEqual(parseDecision(JSON.stringify(d)), d);
  assert.deepEqual(parseDecision(`text before ${JSON.stringify(d)} text after`), d);
  assert.deepEqual(parseDecision(JSON.stringify({ result: JSON.stringify(d) })), d);
  assert.equal(parseDecision('no json here'), null);
  const c = cleanDecision({
    orders: [
      { symbol: 'pepeusdt', side: 'buy', usdt: 10, reason: 'x' },
      { symbol: 'ETHUSDT', side: 'buy', usdt: 0, reason: 'x' },
      { symbol: 'ETHUSDT', side: 'sell', qty: 'lots', reason: 'x' },
      { symbol: 'ETHUSDT', side: 'sell', qty: 'all', reason: 'fine' },
    ],
    note: 'n',
  });
  assert.equal(c.orders.length, 0, 'only the first three are looked at');
  assert.equal(c.dropped.length, 4);
  const ok = cleanDecision({ orders: [{ symbol: 'ethusdt', side: 'sell', qty: 'all', reason: 'fine' }], note: '' });
  assert.deepEqual(ok.orders, [{ symbol: 'ETHUSDT', side: 'sell', qty: 'all', reason: 'fine' }]);
});

test('the prompt states the locks, the season rule and no-tools; the schema is strict', () => {
  const p = buildPrompt({ name: 'Grok', account: { cash: '10000' }, snapshot: { markets: {} } });
  assert.match(p, /no tools and no web access/i);
  assert.match(p, /70% of the starting money \(a 30% loss\)/);
  assert.match(p, /at most 10% of equity/);
  const s = decisionSchema();
  assert.deepEqual(s.required, ['orders', 'note']);
  assert.deepEqual(s.properties.orders.items.required, ['symbol', 'side', 'usdt', 'qty', 'reason']);
  assert.throws(() => cliCommand('chatgpt', {}));
});

test('launchd times: 00/06/12/18 UTC in the Mac\'s local time', async () => {
  const { localHours } = await import('../runner/launchd.mjs');
  assert.deepEqual(localHours(480).map((t) => t.hour), [8, 14, 20, 2], 'Taipei');
  assert.deepEqual(localHours(0).map((t) => t.hour), [0, 6, 12, 18]);
});

test('a round that starts more than 30 minutes after its slot is skipped, not made up', async () => {
  const { w, config } = await setup();
  w.clock.t = Date.parse('2026-10-28T07:10:00Z'); // 70 min after the 06:00 slot (Mac just woke up)
  let ran = 0;
  const res = await runAll({ config, fetchImpl: w.fetchImpl, exec: () => { ran++; return { status: 0, stdout: '{}' }; }, now: () => w.clock.t, log: () => {} });
  assert.equal(res[0].skipped, 'late');
  assert.equal(res[0].slot, '2026-10-28T06:00:00.000Z');
  assert.equal(ran, 0);
});
