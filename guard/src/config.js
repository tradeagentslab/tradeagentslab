// Where things live (~/.tal) and the config file a person edits through `tal`.

import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { BRAND, ENV_HOME } from './brand.js';
import { canon } from './canon.js';
import { parse } from './money.js';
import { DEFAULT_LIMITS, DEFAULT_SYMBOLS, validateLimits, validateSymbols } from './rules.js';

export const AGENT_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;

// Paper trading on this machine, or orders sent to the public arena. Exchange
// testnets come next; live trading does not exist in this version at all.
export const VENUES = Object.freeze(['paper', 'arena']);
const LATER = { 'binance-testnet': 'a later version', 'okx-demo': 'a later version' };

export function homeDir(env = process.env) {
  return env[ENV_HOME] || join(homedir(), `.${BRAND.short}`);
}

export function pathsFor(root, agent) {
  return {
    root,
    config: join(root, 'config.json'),
    halt: join(root, 'HALT'),
    key: join(root, 'keys', `${agent}.key`),
    state: join(root, 'state', `${agent}.json`),
    ledger: join(root, 'ledger', agent),
    lock: join(root, 'locks', `${agent}.lock`),
  };
}

export function defaultConfig(agent = 'my-agent') {
  return {
    version: 1,
    agent,
    venue: 'paper',
    start_cash: '10000',
    price_source: 'binance',
    symbols: [...DEFAULT_SYMBOLS],
    limits: { ...DEFAULT_LIMITS },
  };
}

/** Throws a plain-language error if the config cannot be used. */
export function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('config is not an object');
  if (!AGENT_RE.test(cfg.agent ?? '')) throw new Error('agent: 3–32 characters, lowercase letters, digits and -');
  if (cfg.venue === 'live') throw new Error('venue "live" does not exist in v0: the guard only does paper trading.');
  if (LATER[cfg.venue]) throw new Error(`venue "${cfg.venue}" arrives in ${LATER[cfg.venue]}; this version supports: ${VENUES.join(', ')}`);
  if (cfg.arena_url != null && !/^https:\/\/[^\s]+$/.test(cfg.arena_url)) throw new Error('arena_url must be an https address');
  if (!VENUES.includes(cfg.venue)) throw new Error(`venue must be one of: ${VENUES.join(', ')}`);
  if (!['binance', 'okx'].includes(cfg.price_source)) throw new Error('price_source must be binance or okx');
  const cash = parse(String(cfg.start_cash));
  if (cash <= 0n) throw new Error('start_cash must be positive');
  return {
    ...cfg,
    symbols: validateSymbols(cfg.symbols),
    limits: validateLimits(cfg.limits),
  };
}

export function loadConfig(root) {
  const file = join(root, 'config.json');
  if (!existsSync(file)) throw new Error(`no config at ${file}; run: ${BRAND.short} init`);
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  return validateConfig(cfg);
}

export function saveConfig(root, cfg) {
  const file = join(root, 'config.json');
  writeJson(file, validateConfig(cfg));
}

/** Limits with every value as a string, so they can go into the signed ledger. */
export function limitsForLedger(limits) {
  return Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, String(v)]));
}

/**
 * Fingerprint of the parts of the config that change what trades are allowed.
 * start_cash is left out: it only counts the first time (when the ledger starts).
 */
export function configHash(cfg) {
  const body = canon({ venue: cfg.venue, symbols: cfg.symbols, limits: limitsForLedger(cfg.limits) });
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

/** Write JSON atomically with mode 600. */
export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** Run fn while holding a lock file. Locks older than `staleMs` are taken over. */
export async function withLock(file, fn, { waitMs = 5000, staleMs = 30_000 } = {}) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const start = Date.now();
  for (;;) {
    try {
      closeSync(openSync(file, 'wx', 0o600));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(file).mtimeMs > staleMs) unlinkSync(file);
      } catch { /* gone already */ }
      if (Date.now() - start > waitMs) throw new Error('another guard process is busy; try again');
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try {
    return await fn();
  } finally {
    try { unlinkSync(file); } catch { /* fine */ }
  }
}
