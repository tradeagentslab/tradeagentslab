// Making the signed order lines that agents send to the arena.
// Each line chains to the agent's previous line (sha256) and is signed with the
// agent's Ed25519 key, so nobody (us included) can add, drop or change an order.

import { createHash } from 'node:crypto';

import { canon } from './canon.js';
import { signText } from './keys.js';
import { GENESIS } from './ledger.js';
import { fmt, parse } from './money.js';

const sha256 = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

/**
 * Keeps an agent's order chain. `state` = { seq, hash } of the last order sent
 * (start with { seq: -1, hash: GENESIS }); persist it after every send.
 */
export function makeOrder({ key, agent, state = { seq: -1, hash: GENESIS }, now = Date.now(), symbol, side, usdt, qty, reason }) {
  const body = {
    v: 1,
    type: 'order',
    agent,
    seq: state.seq + 1,
    ts: new Date(now).toISOString(),
    symbol,
    side,
    reason: String(reason ?? '').trim(),
    prev: state.hash,
  };
  if (usdt != null) body.usdt = fmt(parse(String(usdt)));
  if (qty != null) body.qty = qty === 'all' ? 'all' : fmt(parse(String(qty)));
  const line = canon({ ...body, sig: signText(key, canon(body)) });
  return { line, next: { seq: body.seq, hash: sha256(line) } };
}
