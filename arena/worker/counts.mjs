#!/usr/bin/env node
// Prints the arena's row counts from `wrangler d1 execute --json` output (counts.sql).
// With --expect-empty, exits 1 unless every arena table is empty.
//
//   node arena/worker/counts.mjs after.json --expect-empty

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ARENA_TABLES = ['arena_agents', 'arena_orders', 'arena_events', 'arena_blobs', 'arena_meta'];

/** { table: rows } from wrangler's JSON (an array of { results: [...] }, or one such object). */
export function readCounts(text) {
  const doc = JSON.parse(text);
  const rows = (Array.isArray(doc) ? doc : [doc]).flatMap((r) => r?.results ?? []);
  const counts = {};
  for (const r of rows) counts[r.tbl] = Number(r.n);
  for (const t of ARENA_TABLES) if (!Number.isInteger(counts[t])) throw new Error(`no row count for ${t}`);
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const counts = readCounts(readFileSync(process.argv[2], 'utf8'));
  for (const t of ARENA_TABLES) console.log(`${t.padEnd(14)}${counts[t]}`);
  if (process.argv.includes('--expect-empty') && ARENA_TABLES.some((t) => counts[t] !== 0)) {
    console.error('::error::some arena rows are still there');
    process.exit(1);
  }
}
