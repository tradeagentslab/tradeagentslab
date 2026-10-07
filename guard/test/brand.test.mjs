// Renaming should mean editing brand.js and package.json only. This keeps it that way.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BRAND } from '../src/brand.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test('package.json agrees with brand.js', () => {
  assert.equal(pkg.name, BRAND.npm);
  assert.deepEqual(Object.keys(pkg.bin), [BRAND.short]);
  assert.equal(pkg.dependencies, undefined, 'no runtime dependencies');
  assert.ok(existsSync(join(ROOT, 'skills', BRAND.skill, 'SKILL.md')));
});

test('no brand names hard-coded outside brand.js', () => {
  const words = [BRAND.name, BRAND.site, BRAND.npm, BRAND.mcpName, 'tradeagentslab'];
  const files = ['src', 'bin', 'skills'].flatMap((d) => walk(join(ROOT, d)))
    .filter((f) => !f.endsWith(join('src', 'brand.js')));
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const w of words) assert.ok(!text.includes(w), `${f} mentions ${w}`);
  }
});
