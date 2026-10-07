// `tal init` / `tal uninstall`: register the guard with the agent apps found on
// this machine, using each app's own command, and copy the zero-code template.
// Everything is planned first (so --dry-run can show it), then applied.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BRAND } from './brand.js';
import { defaultConfig, homeDir, pathsFor, saveConfig } from './config.js';
import { loadOrCreateKey, publicRaw } from './keys.js';

export const CLIENTS = Object.freeze(['claude', 'codex', 'openclaw']);
const CODEX_APP = '/Applications/Codex.app/Contents/Resources/codex';
const MARKER = '.managed-by-guard';
const SKILL_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', BRAND.skill);

/** Find the agent apps. `which` returns a path or null. */
export function detectClients({ which, exists = existsSync, platform = process.platform }) {
  return {
    claude: which('claude'),
    codex: which('codex') ?? (platform === 'darwin' && exists(CODEX_APP) ? CODEX_APP : null),
    openclaw: which('openclaw'),
  };
}

/** The command each app should run to start the guard. Pinned to an exact version. */
export function serverCommand({ version, localBin }) {
  return localBin
    ? { command: process.execPath, args: [localBin, 'serve'] }
    : { command: 'npx', args: ['-y', `${BRAND.npm}@${version}`, 'serve'] };
}

const skillDirs = (home) => ({
  claude: join(home, '.claude', 'skills', BRAND.skill),
  codex: join(home, '.agents', 'skills', BRAND.skill), // Codex and OpenClaw both read ~/.agents/skills
  openclaw: join(home, '.agents', 'skills', BRAND.skill),
});

/**
 * Work out what init will do. Nothing is touched here.
 * clients: from detectClients(); only: optional list to limit which apps.
 */
export function planInstall({ clients, home, root = homeDir(), agent = 'my-agent', version, localBin, only }) {
  const steps = [];
  const p = pathsFor(root, agent);
  if (!existsSync(p.config)) steps.push({ kind: 'config', path: p.config, agent });
  steps.push({ kind: 'key', path: p.key });

  const { command, args } = serverCommand({ version, localBin });
  const dirs = skillDirs(home);
  const skillDone = new Set();
  for (const name of CLIENTS) {
    if (only && !only.includes(name)) continue;
    const bin = clients[name];
    if (!bin) continue;
    if (name === 'claude') {
      steps.push({ kind: 'exec', app: name, bin, args: ['mcp', 'remove', '--scope', 'user', BRAND.mcpName], quiet: true });
      steps.push({ kind: 'exec', app: name, bin, args: ['mcp', 'add', '--scope', 'user', BRAND.mcpName, '--', command, ...args] });
    } else if (name === 'codex') {
      steps.push({ kind: 'exec', app: name, bin, args: ['mcp', 'remove', BRAND.mcpName], quiet: true });
      steps.push({ kind: 'exec', app: name, bin, args: ['mcp', 'add', BRAND.mcpName, '--', command, ...args] });
    } else {
      steps.push({ kind: 'exec', app: name, bin, args: ['mcp', 'set', BRAND.mcpName, JSON.stringify({ command, args })] });
    }
    if (!skillDone.has(dirs[name])) {
      steps.push({ kind: 'skill', app: name, dest: dirs[name] });
      skillDone.add(dirs[name]);
    }
  }
  return steps;
}

export function planUninstall({ clients, home }) {
  const steps = [];
  for (const name of CLIENTS) {
    const bin = clients[name];
    if (!bin) continue;
    const args = name === 'claude' ? ['mcp', 'remove', '--scope', 'user', BRAND.mcpName]
      : name === 'codex' ? ['mcp', 'remove', BRAND.mcpName]
        : ['mcp', 'unset', BRAND.mcpName];
    steps.push({ kind: 'exec', app: name, bin, args, quiet: true });
  }
  for (const dest of new Set(Object.values(skillDirs(home)))) {
    if (existsSync(join(dest, MARKER))) steps.push({ kind: 'rmskill', dest });
  }
  return steps;
}

/** Copy the template, filling in names, and leave a marker so uninstall knows it is ours. */
function copySkill(dest) {
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(SKILL_SRC)) {
    const text = readFileSync(join(SKILL_SRC, f), 'utf8')
      .replaceAll('{{BRAND}}', BRAND.name)
      .replaceAll('{{MCP}}', BRAND.mcpName)
      .replaceAll('{{HOME}}', `~/.${BRAND.short}`)
      .replaceAll('{{CLI}}', BRAND.short)
      .replaceAll('{{SKILL}}', BRAND.skill);
    writeFileSync(join(dest, f), text);
  }
  writeFileSync(join(dest, MARKER), `${BRAND.npm}\n`);
}

/** Do the steps. exec(bin, args) → { status, stdout, stderr }. Returns one line per step. */
export function applySteps(steps, { exec }) {
  const report = [];
  for (const s of steps) {
    if (s.kind === 'config') {
      saveConfig(dirname(s.path), defaultConfig(s.agent));
      report.push({ ok: true, step: s, note: s.path });
    } else if (s.kind === 'key') {
      const pub = publicRaw(loadOrCreateKey(s.path));
      report.push({ ok: true, step: s, note: `public key ${pub}` });
    } else if (s.kind === 'exec') {
      const r = exec(s.bin, s.args);
      if (r.status !== 0 && !s.quiet) {
        report.push({ ok: false, step: s, note: (r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n')[0] });
      } else if (!s.quiet) {
        report.push({ ok: true, step: s });
      }
    } else if (s.kind === 'skill') {
      copySkill(s.dest);
      report.push({ ok: true, step: s, note: s.dest });
    } else if (s.kind === 'rmskill') {
      rmSync(s.dest, { recursive: true, force: true });
      report.push({ ok: true, step: s, note: s.dest });
    }
  }
  return report;
}

/** One readable line per step, for --dry-run and the final report. */
export function describe(step) {
  switch (step.kind) {
    case 'config': return `write default config (paper trading) → ${step.path}`;
    case 'key': return `signing key (stays on this machine) → ${step.path}`;
    case 'exec': return `${step.app}: ${[step.bin, ...step.args].map((a) => (/\s|"|\{/.test(a) ? `'${a}'` : a)).join(' ')}`;
    case 'skill': return `zero-code template → ${step.dest}`;
    case 'rmskill': return `remove template → ${step.dest}`;
    default: return JSON.stringify(step);
  }
}
