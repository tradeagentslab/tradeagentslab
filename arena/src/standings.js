// The standings file: what the leaderboard page, videos and weekly posts read.
// Seven of the row fields (name, model, returnPct, maxDrawdownPct, trades,
// updatedAt, curve) are the ones the video templates already use.

export const SCHEMA = 'arena.standings/v0';

/** Score = return minus half the max drawdown. Rewards steady over lucky. */
export const DD_WEIGHT = 0.5;

const round2 = (x) => Math.round(x * 100) / 100;

/** Worked in half-cents so every machine rounds the same way (halves go up). */
export function score(returnPct, maxDrawdownPct) {
  const halfCents = 2 * Math.round(returnPct * 100) - Math.round(Math.abs(maxDrawdownPct) * 100);
  return Math.round(halfCents / 2) / 100;
}

/** Sort by score, then return, then fewer trades, then id; write `rank` (1 = best). */
export function rank(rows) {
  const sorted = [...rows].sort((a, b) => b.score - a.score
    || b.returnPct - a.returnPct
    || a.trades - b.trades
    || a.agentId.localeCompare(b.agentId));
  return sorted.map((r, i) => ({ ...r, rank: i + 1 }));
}

/**
 * Max drawdown of an equity series, as a positive percent. Equity values are
 * numbers in USDT, oldest first.
 */
export function maxDrawdownPct(equity) {
  let peak = -Infinity;
  let worst = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    if (peak > 0) worst = Math.max(worst, (peak - e) / peak);
  }
  return round2(worst * 100);
}

const STATUS = ['active', 'halted', 'out'];
const DEC = /^\d+(\.\d+)?$/;

/** Problems with a standings document, in plain words; [] means it is fine. */
export function validateStandings(doc) {
  const p = [];
  const need = (cond, msg) => { if (!cond) p.push(msg); };
  need(doc?.schema === SCHEMA, `schema must be "${SCHEMA}"`);
  need(typeof doc?.season === 'string' && doc.season, 'season missing');
  need(['week', 'season', 'live'].includes(doc?.period?.kind), 'period.kind must be week, season or live');
  need(typeof doc?.period?.id === 'string', 'period.id missing');
  for (const k of ['from', 'to']) need(!Number.isNaN(Date.parse(doc?.period?.[k])), `period.${k} must be a date`);
  need(!Number.isNaN(Date.parse(doc?.asOf)), 'asOf must be a date');
  need(typeof doc?.source === 'string' && doc.source.trim(), 'source missing');
  need(typeof doc?.sample === 'boolean', 'sample must be true or false');
  need(DEC.test(doc?.startUsdt ?? ''), 'startUsdt must be a decimal string');
  need(doc?.disclaimer?.zh && doc?.disclaimer?.en, 'disclaimer.zh and disclaimer.en required');
  need(Array.isArray(doc?.rows), 'rows must be a list');
  (doc?.rows ?? []).forEach((r, i) => {
    const at = `rows[${i}]`;
    need(Number.isInteger(r.rank) && r.rank === i + 1, `${at}.rank must be ${i + 1}`);
    for (const k of ['agentId', 'name', 'model', 'updatedAt']) need(typeof r[k] === 'string' && r[k].trim(), `${at}.${k} missing`);
    need(typeof r.official === 'boolean', `${at}.official must be true or false`);
    for (const k of ['returnPct', 'score', 'seasonReturnPct']) need(Number.isFinite(r[k]), `${at}.${k} must be a number`);
    need(Number.isFinite(r.maxDrawdownPct) && r.maxDrawdownPct >= 0, `${at}.maxDrawdownPct must be ≥ 0`);
    need(Number.isInteger(r.trades) && r.trades >= 0, `${at}.trades must be a whole number`);
    need(DEC.test(r.equityUsdt ?? ''), `${at}.equityUsdt must be a decimal string`);
    need(STATUS.includes(r.status), `${at}.status must be one of ${STATUS.join(', ')}`);
    need(Array.isArray(r.curve) && r.curve.length >= 2 && r.curve.length <= 400 && r.curve.every(Number.isFinite),
      `${at}.curve must be 2–400 numbers`);
    if (Number.isFinite(r.returnPct) && Number.isFinite(r.maxDrawdownPct)) {
      need(r.score === score(r.returnPct, r.maxDrawdownPct), `${at}.score must be returnPct − ${DD_WEIGHT} × maxDrawdownPct`);
    }
  });
  return p;
}
