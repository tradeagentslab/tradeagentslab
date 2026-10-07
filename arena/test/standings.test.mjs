import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { maxDrawdownPct, rank, score, validateStandings } from '../src/standings.js';

const sample = JSON.parse(readFileSync(new URL('../format/sample-standings.json', import.meta.url), 'utf8'));

// The video templates read these seven names (ARENA_FIELDS) and these top-level ones.
const VIDEO_ROW_FIELDS = { name: 'string', model: 'string', returnPct: 'number', maxDrawdownPct: 'number', trades: 'number', updatedAt: 'string' };
const VIDEO_BANNED = /稳赚|保证|保本|跟单|带单|信号|喊单|guarantee|risk[- ]?free|copy[- ]?trad|signals?\b|sure[- ]?win|to the moon/i;

test('the sample is a valid standings file', () => {
  assert.deepEqual(validateStandings(sample), []);
});

test('the sample fits what the video templates read', () => {
  assert.equal(typeof sample.source, 'string');
  assert.equal(typeof sample.asOf, 'string');
  assert.equal(sample.sample, true);
  for (const row of sample.rows) {
    for (const [k, type] of Object.entries(VIDEO_ROW_FIELDS)) assert.equal(typeof row[k], type, k);
    assert.ok(Array.isArray(row.curve) && row.curve.length >= 2 && row.curve.length <= 400);
  }
  assert.ok(!VIDEO_BANNED.test(JSON.stringify(sample)), 'no banned words');
});

test('score = return − half the drawdown, rounded the same way everywhere', () => {
  assert.equal(score(3.12, 2.41), 1.92);
  assert.equal(score(1.2, 0.8), 0.8);
  assert.equal(score(-0.85, 1.9), -1.8);
  assert.equal(score(5, -4), 3, 'drawdown sign does not matter');
  assert.equal(score(0, 0), 0);
});

test('rank: score, then return, then fewer trades', () => {
  const rows = rank([
    { agentId: 'b', score: 1, returnPct: 2, trades: 5 },
    { agentId: 'a', score: 1, returnPct: 2, trades: 3 },
    { agentId: 'c', score: 2, returnPct: 1, trades: 9 },
    { agentId: 'd', score: 1, returnPct: 3, trades: 9 },
  ]);
  assert.deepEqual(rows.map((r) => [r.agentId, r.rank]), [['c', 1], ['d', 2], ['a', 3], ['b', 4]]);
});

test('max drawdown from an equity series', () => {
  assert.equal(maxDrawdownPct([10000, 10500, 9975, 10800, 10260]), 5);
  assert.equal(maxDrawdownPct([10000, 10100, 10200]), 0);
});

test('validation explains what is wrong', () => {
  const bad = structuredClone(sample);
  bad.rows[0].score = 9;
  bad.rows[1].rank = 5;
  bad.sample = 'no';
  const problems = validateStandings(bad);
  assert.ok(problems.some((m) => /rows\[0\]\.score/.test(m)));
  assert.ok(problems.some((m) => /rows\[1\]\.rank/.test(m)));
  assert.ok(problems.some((m) => /sample/.test(m)));
});
