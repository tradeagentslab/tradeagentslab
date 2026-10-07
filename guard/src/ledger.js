// The ledger: one JSON line per event, one file per UTC day.
// Each line carries the sha256 of the line before it (so deleting or editing a
// line breaks the chain) and an Ed25519 signature over everything except `sig`.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { canon } from './canon.js';
import { signText, verifyText } from './keys.js';

export const GENESIS = '0'.repeat(64);
const FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => FILE_RE.test(f)).sort();
}

function lines(path) {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0);
}

export class Ledger {
  /** dir: this agent's ledger folder. key: Ed25519 private KeyObject. */
  constructor({ dir, agent, key }) {
    this.dir = dir;
    this.agent = agent;
    this.key = key;
    this._head = null;
  }

  /** { seq, hash } of the last line, or seq -1 and the genesis hash. */
  head() {
    if (this._head) return this._head;
    const all = files(this.dir);
    for (let i = all.length - 1; i >= 0; i--) {
      const ls = lines(join(this.dir, all[i]));
      if (ls.length) {
        const last = ls[ls.length - 1];
        this._head = { seq: JSON.parse(last).seq, hash: sha256(last) };
        return this._head;
      }
    }
    this._head = { seq: -1, hash: GENESIS };
    return this._head;
  }

  /** Forget the cached head (another process may have written). */
  refresh() {
    this._head = null;
  }

  /** Write one event. `data` must be canon-safe (decimals as strings). */
  append(type, data, now = Date.now()) {
    const { seq, hash } = this.head();
    const ts = new Date(now).toISOString();
    const event = { v: 1, agent: this.agent, seq: seq + 1, ts, type, data, prev: hash };
    const sig = signText(this.key, canon(event));
    const line = canon({ ...event, sig });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(this.dir, `${ts.slice(0, 10)}.jsonl`), `${line}\n`, { mode: 0o600 });
    this._head = { seq: event.seq, hash: sha256(line) };
    return { ...event, sig };
  }

  /** All events in order, optionally only from `fromDate` (YYYY-MM-DD) on. */
  *events({ fromDate } = {}) {
    for (const f of files(this.dir)) {
      if (fromDate && f.slice(0, 10) < fromDate) continue;
      for (const l of lines(join(this.dir, f))) yield JSON.parse(l);
    }
  }
}

/**
 * Check every line: valid JSON, canonical, seq counts up by one, prev matches the
 * hash of the line before, signature checks out with `publicKey` (base64 raw).
 */
export function verifyLedger(dir, publicKey) {
  let prev = GENESIS;
  let seq = -1;
  let count = 0;
  for (const f of files(dir)) {
    const ls = lines(join(dir, f));
    for (let i = 0; i < ls.length; i++) {
      const where = { file: f, line: i + 1 };
      let ev;
      try {
        ev = JSON.parse(ls[i]);
      } catch {
        return { ok: false, count, ...where, reason: 'not JSON' };
      }
      if (canon(ev) !== ls[i]) return { ok: false, count, ...where, reason: 'not canonical' };
      if (ev.seq !== seq + 1) return { ok: false, count, ...where, reason: `seq ${ev.seq}, expected ${seq + 1}` };
      if (ev.prev !== prev) return { ok: false, count, ...where, reason: 'chain broken (prev hash)' };
      const { sig, ...body } = ev;
      if (!verifyText(publicKey, canon(body), sig)) return { ok: false, count, ...where, reason: 'bad signature' };
      if (ev.ts.slice(0, 10) !== f.slice(0, 10)) return { ok: false, count, ...where, reason: 'line in the wrong day file' };
      prev = sha256(ls[i]);
      seq = ev.seq;
      count++;
    }
  }
  return { ok: true, count };
}
