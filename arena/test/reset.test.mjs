// The season reset must only ever touch the arena's own tables: the same D1 database
// holds the site's clicks/blocked tables and the bot's tables.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ARENA_TABLES, readCounts } from '../worker/counts.mjs';
import { d1 } from './d1shim.mjs';

const file = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const SCHEMA = file('../worker/schema.sql');
const RESET = file('../worker/reset.sql');
const COUNTS = file('../worker/counts.sql');
const WORKFLOW = file('../../.github/workflows/reset-arena-season.yml');

/** SQL statements without comments, as the workflow sends them. */
const statements = (path) => readFileSync(path, 'utf8').split('\n').filter((l) => !l.startsWith('--')).join(' ')
  .split(';').map((s) => s.trim()).filter(Boolean);

test('reset.sql is exactly one DELETE per arena table, nothing else', () => {
  const st = statements(RESET);
  assert.equal(st.length, ARENA_TABLES.length);
  const targets = st.map((s) => {
    const m = /^DELETE FROM (arena_[a-z_]+)$/.exec(s);
    assert.ok(m, `not a plain DELETE of an arena table: ${s}`);
    return m[1];
  });
  assert.deepEqual([...targets].sort(), [...ARENA_TABLES].sort());
  // and those are all the tables the arena's schema creates
  const created = [...readFileSync(SCHEMA, 'utf8').matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...created].sort(), [...ARENA_TABLES].sort());
});

test('counts.sql only reads arena tables', () => {
  const sql = statements(COUNTS).join(';');
  assert.match(sql, /^SELECT/);
  assert.ok(!/\b(DELETE|DROP|UPDATE|INSERT|ALTER|CREATE|REPLACE|PRAGMA)\b/i.test(sql));
  const tables = [...sql.matchAll(/FROM (\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...tables].sort(), [...ARENA_TABLES].sort());
});

test('on a database shared with other tables: arena rows go, everything else stays', async () => {
  const db = d1([SCHEMA]);
  const exec = (sql) => db.prepare(sql).run();
  await exec('CREATE TABLE clicks (id INTEGER PRIMARY KEY, path TEXT)');
  await exec('CREATE TABLE blocked (id INTEGER PRIMARY KEY, ip TEXT)');
  await exec('CREATE TABLE bot_members (id INTEGER PRIMARY KEY, name TEXT)');
  await exec("INSERT INTO clicks (path) VALUES ('/a'), ('/b')");
  await exec("INSERT INTO blocked (ip) VALUES ('x')");
  await exec("INSERT INTO bot_members (name) VALUES ('m')");
  await exec("INSERT INTO arena_agents (agent_id, name, model, pubkey, joined, last_hash) VALUES ('baseline-hold', 'Hold', '-', '', '2026-10-21T00:00:00Z', 'g')");
  await exec("INSERT INTO arena_orders (agent_id, seq, recv, line) VALUES ('a', 0, 'r', 'l')");
  await exec("INSERT INTO arena_events (seq, agent_id, day, line) VALUES (0, 'a', '2026-10-21', 'l')");
  await exec("INSERT INTO arena_blobs (key, body, updated) VALUES ('standings/latest', '{}', 'u')");
  await exec("INSERT INTO arena_meta (k, v) VALUES ('engine_push', '7')");

  const count = async () => {
    const { results } = await db.prepare(statements(COUNTS)[0]).all();
    return readCounts(JSON.stringify([{ results, success: true }]));
  };
  assert.ok(Object.values(await count()).every((n) => n === 1));
  for (const s of statements(RESET)) await exec(s);
  assert.ok(Object.values(await count()).every((n) => n === 0));
  for (const [t, n] of [['clicks', 2], ['blocked', 1], ['bot_members', 1]]) {
    assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()).n, n, t);
  }
});

test('counts from wrangler JSON: a missing table is an error, not a zero', () => {
  assert.throws(() => readCounts(JSON.stringify([{ results: [{ tbl: 'arena_agents', n: 0 }] }])), /arena_orders/);
});

test('the reset workflow: manual, main only, typed confirmation, runs only reset.sql', () => {
  const y = readFileSync(WORKFLOW, 'utf8');
  const code = y.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.match(code, /on:\n {2}workflow_dispatch:/);
  assert.ok(!/\n {2}(push|schedule|pull_request|workflow_run):/.test(code));
  assert.match(code, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(code, /if \[ "\$CONFIRM" != "delete S0" \]/);
  assert.match(y, /IRREVERSIBLE/);
  assert.match(y, /owner has approved it in the TAL session/);
  const executes = [...code.matchAll(/d1 execute ([^\n]+)/g)].map((m) => m[1]);
  assert.equal(executes.length, 3);
  for (const e of executes) assert.match(e, /^tal --remote (--json )?--command "\$sql"/);
  const sources = [...code.matchAll(/grep -v '\^--' (arena\/worker\/\w+\.sql)/g)].map((m) => m[1]);
  assert.deepEqual(sources, ['arena/worker/counts.sql', 'arena/worker/reset.sql', 'arena/worker/counts.sql']);
});
