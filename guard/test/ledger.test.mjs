import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { canon } from '../src/canon.js';
import { loadOrCreateKey, publicRaw, signText, verifyText } from '../src/keys.js';
import { Ledger, verifyLedger } from '../src/ledger.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'guard-ledger-'));

test('canon sorts keys, refuses floats', () => {
  assert.equal(canon({ b: 1, a: ['x', true, null], c: { z: '1.5', y: 2 } }), '{"a":["x",true,null],"b":1,"c":{"y":2,"z":"1.5"}}');
  assert.throws(() => canon({ price: 1.5 }));
  assert.throws(() => canon({ n: 10n }));
  assert.equal(canon({ a: undefined, b: 1 }), '{"b":1}');
});

test('keys: created with mode 600, sign and verify', () => {
  const dir = tmp();
  const file = join(dir, 'keys', 'a.key');
  const key = loadOrCreateKey(file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const pub = publicRaw(key);
  assert.equal(Buffer.from(pub, 'base64').length, 32);
  const sig = signText(key, 'hello');
  assert.equal(verifyText(pub, 'hello', sig), true);
  assert.equal(verifyText(pub, 'hellO', sig), false);
  assert.equal(publicRaw(loadOrCreateKey(file)), pub, 'loading again gives the same key');
});

function setup() {
  const dir = tmp();
  const key = loadOrCreateKey(join(dir, 'k.key'));
  const led = new Ledger({ dir: join(dir, 'ledger'), agent: 'test-agent', key });
  return { dir: join(dir, 'ledger'), key, led, pub: publicRaw(key) };
}

test('append, read back, verify across days', () => {
  const { dir, led, pub } = setup();
  const day1 = Date.parse('2026-10-08T23:59:59Z');
  led.append('init', { start_cash: '10000.00000000' }, day1 - 1000);
  led.append('order', { symbol: 'BTCUSDT', side: 'buy', usdt: '100.00000000' }, day1);
  led.append('fill', { symbol: 'BTCUSDT', qty: '0.00153846' }, day1 + 2000);
  const evs = [...led.events()];
  assert.deepEqual(evs.map((e) => e.seq), [0, 1, 2]);
  assert.equal(evs[2].ts.slice(0, 10), '2026-10-09');
  assert.deepEqual(verifyLedger(dir, pub), { ok: true, count: 3 });

  const again = new Ledger({ dir, agent: 'test-agent', key: led.key });
  again.append('journal', { text: 'next process continues the chain' }, day1 + 5000);
  assert.deepEqual(verifyLedger(dir, pub), { ok: true, count: 4 });
});

test('editing a line breaks the signature', () => {
  const { dir, led, pub } = setup();
  const t = Date.parse('2026-10-08T10:00:00Z');
  led.append('order', { usdt: '100.00000000' }, t);
  led.append('order', { usdt: '200.00000000' }, t + 1);
  const f = join(dir, '2026-10-08.jsonl');
  writeFileSync(f, readFileSync(f, 'utf8').replace('100.00000000', '900.00000000'));
  const r = verifyLedger(dir, pub);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad signature');
  assert.equal(r.line, 1);
});

test('deleting a line breaks the chain', () => {
  const { dir, led, pub } = setup();
  const t = Date.parse('2026-10-08T10:00:00Z');
  for (let i = 0; i < 3; i++) led.append('journal', { text: `n${i}` }, t + i);
  const f = join(dir, '2026-10-08.jsonl');
  const ls = readFileSync(f, 'utf8').split('\n').filter(Boolean);
  writeFileSync(f, `${[ls[0], ls[2]].join('\n')}\n`);
  const r = verifyLedger(dir, pub);
  assert.equal(r.ok, false);
  assert.match(r.reason, /seq/);
});

test('someone else\'s key does not verify', () => {
  const a = setup();
  const b = setup();
  a.led.append('journal', { text: 'mine' }, Date.parse('2026-10-08T10:00:00Z'));
  assert.equal(verifyLedger(a.dir, b.pub).ok, false);
});
