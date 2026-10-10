// The demo's scripted agent drives the real MCP server (`tal serve`) and shows the
// guard's real answers. No network: TAL_OFFLINE=1 gives the guard made-up prices.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { defaultConfig, saveConfig } from '../guard/src/config.js';
import { callTool, formatResult, parseArgs } from './agent.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DISCLAIMER = "Paper trading. Past results do not predict the future. Not investment advice.";

function home() {
  const root = mkdtempSync(join(tmpdir(), 'tal-demo-'));
  saveConfig(root, defaultConfig('demo-agent'));
  return { ...process.env, TAL_HOME: root, TAL_OFFLINE: '1', LANG: 'C.UTF-8' };
}

const order = (env, args) => callTool('place_order', { side: 'buy', ...args }, { env });

test('parseArgs: key=value words, plain numbers become numbers', () => {
  assert.deepEqual(parseArgs(['symbol=BTC', 'usdt=500', 'qty=0.5', 'reason=Small first position.']), {
    symbol: 'BTC', usdt: 500, qty: 0.5, reason: 'Small first position.',
  });
  assert.throws(() => parseArgs(['oops']), /key=value/);
});

test('the demo story, against the real server: pass, two refusals, halt, refused', async () => {
  const env = home();

  const ok = await order(env, { symbol: 'BTC', usdt: 500, reason: 'Small first position.' });
  const okLines = formatResult(ok);
  assert.equal(okLines[0], '✓ status: accepted');
  assert.ok(okLines.some((l) => /^ {2}fills_at: /.test(l)));

  const big = formatResult(await order(env, { symbol: 'ETH', usdt: 2500, reason: 'All in on ETH.' }));
  assert.deepEqual(big, ['✗ REJECTED (max_order): One order can use at most 10% of equity (1000 USDT now).']);

  const pepe = formatResult(await order(env, { symbol: 'PEPE', usdt: 200, reason: 'Trending coin.' }));
  assert.match(pepe[0], /^✗ REJECTED \(symbol\): PEPEUSDT is not on the list/);

  const halted = await callTool('halt', { reason: 'Stop for today.' }, { env });
  assert.equal(halted.isError, false);

  const after = formatResult(await order(env, { symbol: 'BTC', usdt: 100, reason: 'Buy the dip.' }));
  assert.match(after[0], /^✗ REJECTED \(halted\): Trading is halted\./);
});

test('formatResult: colour only when asked, tool errors pass through', () => {
  const rej = { content: [{ type: 'text', text: 'REJECTED (symbol): no.\n{}' }], isError: false };
  assert.equal(formatResult(rej)[0], '✗ REJECTED (symbol): no.');
  assert.match(formatResult(rej, { color: true })[0], /^\x1b\[1;31m✗ REJECTED/);
  const err = { content: [{ type: 'text', text: 'Error: market data unavailable' }], isError: true };
  assert.deepEqual(formatResult(err), ['Error: market data unavailable']);
});

test('the tape uses only real commands, stays offline, and ends on the disclaimer', () => {
  const tape = readFileSync(join(HERE, 'guard-demo.tape'), 'utf8');
  const end = readFileSync(join(HERE, 'end.txt'), 'utf8');
  assert.match(tape, /TAL_OFFLINE=1/);
  assert.ok(end.includes(DISCLAIMER));
  assert.match(tape, /cat "\$DEMO\/end\.txt"/);
  const typed = [...tape.matchAll(/^Type [`"](.*)[`"]$/gm)].map((m) => m[1]);
  for (const line of typed.filter((l) => /^(agent|tal) /.test(l) || l === 'tal init' || l === 'tal status')) {
    assert.match(line, /^(tal (init|status|halt)|agent place_order)\b/, line);
  }
  for (const line of [...typed, end]) {
    for (const l of String(line).split('\n')) assert.ok(l.length <= 100, `over 100 columns: ${l}`);
  }
  assert.doesNotMatch(tape + end, /api[_-]?key|secret|password/i);
});
