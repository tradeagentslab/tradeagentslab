import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BRAND, ENV_HOME } from '../src/brand.js';
import { main } from '../src/cli.js';
import { defaultConfig, saveConfig } from '../src/config.js';

const T = Date.parse('2026-10-08T12:00:30Z');

// A fake machine: a PATH with fake agent apps, a home folder, and recorded commands.
function machine({ apps = ['claude', 'codex', 'openclaw'], tty = false, answers = [] } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'guard-cli-'));
  const bin = join(base, 'bin');
  const home = join(base, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  for (const a of apps) {
    writeFileSync(join(bin, a), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, a), 0o755);
  }
  const out = [];
  const err = [];
  const ran = [];
  const io = {
    env: { PATH: bin, [ENV_HOME]: join(home, `.${BRAND.short}`), LANG: 'en_US.UTF-8', [`${BRAND.short.toUpperCase()}_OFFLINE`]: '1' },
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    isTTY: () => tty,
    ask: async () => answers.shift() ?? '',
    exec: (b, args) => { ran.push([b.split('/').pop(), ...args]); return { status: 0, stdout: '', stderr: '' }; },
    home: () => home,
    now: () => T,
    platform: 'linux', // keeps the real /Applications/Codex.app out of the test
  };
  return { io, out, err, ran, home, root: io.env[ENV_HOME] };
}

test('init registers with all three apps using their own commands, pinned version', async () => {
  const m = machine();
  assert.equal(await main(['init'], m.io), 0);
  const pin = `${BRAND.npm}@${JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version}`;
  assert.deepEqual(m.ran.find((r) => r[0] === 'claude' && r[2] === 'add'),
    ['claude', 'mcp', 'add', '--scope', 'user', BRAND.mcpName, '--', 'npx', '-y', pin, 'serve']);
  assert.deepEqual(m.ran.find((r) => r[0] === 'codex' && r[2] === 'add'),
    ['codex', 'mcp', 'add', BRAND.mcpName, '--', 'npx', '-y', pin, 'serve']);
  const oc = m.ran.find((r) => r[0] === 'openclaw');
  assert.deepEqual(oc.slice(0, 4), ['openclaw', 'mcp', 'set', BRAND.mcpName]);
  assert.deepEqual(JSON.parse(oc[4]), { command: 'npx', args: ['-y', pin, 'serve'] });

  const claudeSkill = join(m.home, '.claude', 'skills', BRAND.skill, 'SKILL.md');
  const agentsSkill = join(m.home, '.agents', 'skills', BRAND.skill, 'SKILL.md');
  assert.ok(existsSync(claudeSkill) && existsSync(agentsSkill));
  const skill = readFileSync(claudeSkill, 'utf8');
  assert.ok(!skill.includes('{{'), 'placeholders filled');
  assert.match(skill, new RegExp(`name: ${BRAND.skill}`));

  const cfg = JSON.parse(readFileSync(join(m.root, 'config.json'), 'utf8'));
  assert.equal(cfg.venue, 'paper');
  assert.ok(existsSync(join(m.root, 'keys', 'my-agent.key')));
  assert.ok(m.out.some((l) => l.includes(`${BRAND.site}/en/account/`)), 'mentions step 0, on our own site');
});

test('init --dry-run changes nothing', async () => {
  const m = machine();
  assert.equal(await main(['init', '--dry-run'], m.io), 0);
  assert.equal(m.ran.length, 0);
  assert.ok(!existsSync(m.root));
  assert.ok(m.out.some((l) => l.includes('claude: ')));
});

test('init with no agent apps says so', async () => {
  const m = machine({ apps: [] });
  await main(['init'], m.io);
  assert.ok(m.err.some((l) => /No agent app found/.test(l)));
});

test('uninstall removes the registrations and only our template; ledger stays', async () => {
  const m = machine();
  await main(['init'], m.io);
  const mine = join(m.home, '.claude', 'skills', 'someone-elses');
  mkdirSync(mine, { recursive: true });
  m.ran.length = 0;
  assert.equal(await main(['uninstall'], m.io), 0);
  assert.ok(m.ran.some((r) => r[0] === 'openclaw' && r[2] === 'unset'));
  assert.ok(!existsSync(join(m.home, '.claude', 'skills', BRAND.skill)));
  assert.ok(existsSync(mine));
  assert.ok(existsSync(join(m.root, 'config.json')));
});

function ready() {
  const m = machine();
  saveConfig(m.root, defaultConfig('my-agent'));
  return m;
}

test('status, halt, verify, replay work on an offline demo market', async () => {
  const m = ready();
  assert.equal(await main(['status'], m.io), 0);
  assert.ok(m.out.some((l) => /equity 10000 USDT/.test(l)));
  assert.equal(await main(['halt', '--reason', 'testing'], m.io), 0);
  assert.ok(m.out.some((l) => /HALTED: testing/.test(l)));
  assert.equal(await main(['verify'], m.io), 0);
  assert.ok(m.out.some((l) => /chain and signatures OK/.test(l)));
  assert.equal(await main(['replay'], m.io), 0);
  assert.ok(m.out.some((l) => /halt\s+by human: testing/.test(l)));
});

test('resume and limits set need a person at a terminal', async () => {
  const m = ready();
  await main(['halt'], m.io);
  assert.equal(await main(['resume'], m.io), 1);
  assert.ok(m.err.some((l) => /person at a terminal/.test(l)));
  assert.equal(await main(['limits', 'set', 'max_order_pct=50'], m.io), 1);

  const p = machine({ tty: true, answers: ['no', 'yes', 'yes'] });
  p.io.env = m.io.env;
  assert.equal(await main(['resume'], p.io), 1, 'answering no keeps the halt');
  assert.equal(await main(['resume'], p.io), 0);
  assert.equal(await main(['limits', 'set', 'max_order_pct=5'], p.io), 0);
  assert.ok(p.out.some((l) => /"max_order_pct": 5/.test(l)));
});

test('unknown command and bad config are explained', async () => {
  const m = machine();
  assert.equal(await main(['frobnicate'], m.io), 2);
  assert.equal(await main(['status'], m.io), 1);
  assert.ok(m.err.some((l) => /no config/.test(l)));
  const cfg = defaultConfig('my-agent');
  saveConfig(m.root, cfg);
  writeFileSync(join(m.root, 'config.json'), JSON.stringify({ ...cfg, venue: 'live' }));
  assert.equal(await main(['status'], m.io), 1);
  assert.ok(m.err.some((l) => /does not exist in v0/.test(l)));
});
