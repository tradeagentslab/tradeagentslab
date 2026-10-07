import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createServer, PROTOCOL_VERSIONS, serveStdio, TOOLS } from '../src/mcp.js';
import { setup } from './helpers.mjs';

const call = (server, id, method, params) => server.handle({ jsonrpc: '2.0', id, method, params });

test('initialize answers with a version the client asked for, or ours', async () => {
  const { guard } = setup();
  const server = createServer({ guard, version: '0.1.0' });
  const r = await call(server, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(r.result.protocolVersion, '2025-06-18');
  assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
  assert.match(r.result.instructions, /simulated/);
  const r2 = await call(server, 2, 'initialize', { protocolVersion: '1999-01-01' });
  assert.equal(r2.result.protocolVersion, PROTOCOL_VERSIONS[0]);
});

test('exactly eight tools, none of them can withdraw, borrow or unlock', async () => {
  const { guard } = setup();
  const server = createServer({ guard, version: '0.1.0' });
  const r = await call(server, 1, 'tools/list', {});
  const names = r.result.tools.map((t) => t.name);
  assert.deepEqual(names, ['market', 'account', 'place_order', 'cancel_order', 'fills', 'rules', 'halt', 'journal']);
  assert.equal(TOOLS.length, 8);
  for (const bad of ['withdraw', 'transfer', 'leverage', 'resume', 'set_limits', 'futures']) {
    assert.ok(!names.some((n) => n.includes(bad)), bad);
  }
  for (const t of r.result.tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.call, undefined, 'handlers are not sent to the client');
  }
});

test('tools/call place_order then account', async () => {
  const { guard } = setup();
  const server = createServer({ guard, version: '0.1.0' });
  const r = await call(server, 1, 'tools/call', { name: 'place_order', arguments: { symbol: 'BTC', side: 'buy', usdt: 100, reason: 'try it' } });
  assert.equal(r.result.isError, false);
  assert.match(r.result.content[0].text, /"status": "accepted"/);
  const a = await call(server, 2, 'tools/call', { name: 'account', arguments: {} });
  assert.match(a.result.content[0].text, /"pending_orders"/);
});

test('a rejected order says REJECTED first; tool errors come back as isError', async () => {
  const { guard, market } = setup();
  const server = createServer({ guard, version: '0.1.0' });
  const r = await call(server, 1, 'tools/call', { name: 'place_order', arguments: { symbol: 'PEPE', side: 'buy', usdt: 100, reason: 'x' } });
  assert.match(r.result.content[0].text, /^REJECTED \(symbol\)/);
  market.down = true;
  const e = await call(server, 2, 'tools/call', { name: 'place_order', arguments: { symbol: 'BTC', side: 'buy', usdt: 100, reason: 'x' } });
  assert.equal(e.result.isError, true);
  assert.match(e.result.content[0].text, /market data unavailable/);
});

test('the agent can halt but there is no tool to resume', async () => {
  const { guard } = setup();
  const server = createServer({ guard, version: '0.1.0' });
  const r = await call(server, 1, 'tools/call', { name: 'halt', arguments: { reason: 'looks wrong' } });
  assert.match(r.result.content[0].text, /"by": "agent"/);
  const u = await call(server, 2, 'tools/call', { name: 'resume', arguments: {} });
  assert.equal(u.error.code, -32602);
});

test('protocol errors: unknown method, notification, bad request', async () => {
  const { guard } = setup();
  const server = createServer({ guard, version: '0.1.0' });
  assert.equal((await call(server, 1, 'resources/list', {})).error.code, -32601);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await server.handle({ id: 3, method: 'ping' })).error.code, -32600);
  assert.deepEqual((await call(server, 4, 'ping', {})).result, {});
});

test('stdio: one JSON message per line in and out; bad JSON gets a parse error', async () => {
  const { guard } = setup();
  const input = new PassThrough();
  const output = new PassThrough();
  const done = serveStdio(createServer({ guard, version: '0.1.0' }), { input, output });
  const lines = [];
  output.on('data', (b) => lines.push(...b.toString().split('\n').filter(Boolean)));
  input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  input.write('not json\n');
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  input.end();
  await done;
  await new Promise((r) => setImmediate(r));
  const msgs = lines.map((l) => JSON.parse(l));
  assert.deepEqual(msgs.find((m) => m.id === 1).result, {});
  assert.equal(msgs.find((m) => m.id === null).error.code, -32700);
  assert.equal(msgs.length, 2, 'notifications get no answer');
});
