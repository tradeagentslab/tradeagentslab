// Recompute a published arena board from the public data alone:
//   agents.json, weekly/<week>.json (or season/<id>.json), ledgers/<agent>/<day>.json
//   (agent-signed orders, arena-signed results) and Binance spot public candles.
//
// 1. Every order line: canonical, signed by the agent's key in agents.json, chained.
// 2. Every result line: canonical, signed by the arena's key, chained.
// 3. Replay the season with the engine's own code (engine.js: same fills, fees,
//    locks, baselines, drawdown, score and ranking) from the season's first minute
//    to the end of the board's period.
// 4. Compare every result line and every board field with what the replay made.
//
// This file does no network I/O; candles come from klines.js.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { canon } from '../canon.js';
import { verifyText } from '../keys.js';
import { GENESIS } from '../ledger.js';
import { DEFAULT_SYMBOLS } from '../rules.js';
import { BASELINES } from './baselines.js';
import { Arena, MINUTE } from './engine.js';

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const ENGINE_LEDGER = 'arena-engine';
const MA_BASELINE = 'baseline-ma';

const sha256 = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const iso = (ms) => new Date(ms).toISOString();
const short = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? '(none)' : s.length > 80 ? `${s.slice(0, 77)}...` : s;
};

/** JSON with sorted keys: for comparing values (boards hold plain numbers, so not canon()). */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** The data can't be recomputed at all (missing files, no key): exit 2, not "mismatch". */
export class RecomputeInputError extends Error {}

// ---------- reading the published files ----------

export function loadArenaData(dir) {
  const readJson = (rel) => {
    try {
      return JSON.parse(readFileSync(join(dir, rel), 'utf8'));
    } catch (err) {
      throw new RecomputeInputError(`${rel}: ${err.message}`);
    }
  };
  const list = (sub, re) => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)).filter((f) => re.test(f)).sort() : []);
  if (!existsSync(join(dir, 'agents.json'))) throw new RecomputeInputError(`no agents.json in ${dir}: point --data at a copy of the arena-data repository`);
  const agents = readJson('agents.json').agents ?? [];
  const weeks = Object.fromEntries(list('weekly', /^\d{4}-W\d{2}\.json$/).map((f) => [f.slice(0, -5), readJson(`weekly/${f}`)]));
  const seasons = Object.fromEntries(list('season', /^S\d{1,3}\.json$/).map((f) => [f.slice(0, -5), readJson(`season/${f}`)]));
  const ledgers = [];
  for (const agent of list('ledgers', /^[a-z0-9][a-z0-9-]{2,31}$/)) {
    for (const f of list(`ledgers/${agent}`, /^\d{4}-\d{2}-\d{2}\.json$/)) {
      ledgers.push({ agent, day: f.slice(0, 10), file: `ledgers/${agent}/${f}`, doc: readJson(`ledgers/${agent}/${f}`) });
    }
  }
  return { agents, weeks, seasons, ledgers };
}

/** Which board, and the minutes to replay: [season start, end of the board's period). */
export function planPeriod(data, { week, season, seasonFrom } = {}) {
  let kind;
  let board;
  if (season) {
    kind = 'season';
    board = data.seasons[season];
    if (!board) throw new RecomputeInputError(`no season/${season}.json`);
  } else {
    kind = 'week';
    const id = week ?? Object.keys(data.weeks).sort().pop();
    if (!id) throw new RecomputeInputError('no weekly board in weekly/');
    board = data.weeks[id];
    if (!board) throw new RecomputeInputError(`no weekly/${id}.json`);
  }
  const seasonId = board.season;
  let from = seasonFrom != null ? Date.parse(seasonFrom) : null;
  if (from == null && data.seasons[seasonId]) from = Date.parse(data.seasons[seasonId].period.from);
  if (from == null) {
    // The season's first week starts with the season; later weeks start on Mondays.
    const starts = Object.values(data.weeks).filter((b) => b.season === seasonId).map((b) => Date.parse(b.period.from));
    from = Math.min(...starts);
  }
  const to = Date.parse(board.period.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new RecomputeInputError('cannot tell when the season starts; pass --season-from');
  return { kind, id: board.period.id, board, season: { id: seasonId, from, to } };
}

// ---------- 1 and 2: signatures and chains ----------

function checkOrders(data, agentsById, problems) {
  const byAgent = new Map();
  for (const L of data.ledgers) {
    for (const o of L.doc.orders ?? []) {
      if (!byAgent.has(L.agent)) byAgent.set(L.agent, []);
      byAgent.get(L.agent).push({ ...o, file: L.file });
    }
  }
  const replayable = [];
  let lines = 0;
  for (const [agent, list] of byAgent) {
    const no = (what, seq = null) => problems.push({ area: 'orders', agent, seq, what });
    const g = agentsById[agent];
    if (!g) no('orders from an agent that is not in agents.json');
    const bySeq = new Map();
    for (const o of list) {
      lines += 1;
      let p;
      try {
        p = JSON.parse(o.line);
      } catch {
        no(`${o.file}: an order line is not JSON`);
        continue;
      }
      if (bySeq.has(p.seq)) {
        if (bySeq.get(p.seq).line !== o.line) no(`two different order lines with seq ${p.seq}`, p.seq);
        continue;
      }
      bySeq.set(p.seq, { ...o, p });
    }
    const seqs = [...bySeq.keys()].sort((a, b) => a - b);
    let prevHash = GENESIS;
    let expect = 0;
    for (const s of seqs) {
      const { p, line, recv, file } = bySeq.get(s);
      if (s !== expect) no(`order chain broken: seq ${expect}${s > expect + 1 ? `–${s - 1}` : ''} missing`, s);
      let canonical = false;
      try {
        canonical = canon(p) === line;
      } catch { /* not canon-safe */ }
      if (!canonical) no(`order ${s} is not canonical JSON`, s);
      if (p.agent !== agent) no(`order ${s} in ${file} is for agent ${short(p.agent)}`, s);
      const { sig, ...body } = p;
      if (g?.pubkey && !(canonical && verifyText(g.pubkey, canon(body), sig ?? ''))) no(`order ${s}: signature does not match the agent's key in agents.json`, s);
      if (s === expect && p.prev !== prevHash) no(`order chain broken at seq ${s}: prev is not the hash of order ${s - 1}`, s);
      if (Number.isNaN(Date.parse(recv))) no(`order ${s}: receive time missing`, s);
      prevHash = sha256(line);
      expect = s + 1;
      replayable.push({ agent, seq: s, recv: Date.parse(recv), line });
    }
  }
  return { replayable, lines };
}

function checkResults(data, arenaKey, problems) {
  const bySeq = new Map();
  let lines = 0;
  for (const L of data.ledgers) {
    for (const line of L.doc.results ?? []) {
      lines += 1;
      const no = (what, seq = null) => problems.push({ area: 'results', agent: L.agent, seq, what });
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        no(`${L.file}: a result line is not JSON`);
        continue;
      }
      let canonical = false;
      try {
        canonical = canon(ev) === line;
      } catch { /* not canon-safe */ }
      if (!canonical) no(`result ${ev.seq} is not canonical JSON`, ev.seq);
      const { sig, ...body } = ev;
      if (!(canonical && verifyText(arenaKey, canon(body), sig ?? ''))) no(`result ${ev.seq}: signature does not match the arena's key`, ev.seq);
      if (ev.agent !== ENGINE_LEDGER) no(`result ${ev.seq} is not from the arena's ledger`, ev.seq);
      if (ev.data?.agent !== L.agent) no(`result ${ev.seq} in ${L.file} is about ${short(ev.data?.agent)}`, ev.seq);
      if (typeof ev.ts !== 'string' || ev.ts.slice(0, 10) !== L.day) no(`result ${ev.seq} is in the wrong day file`, ev.seq);
      if (bySeq.has(ev.seq)) {
        if (bySeq.get(ev.seq).line !== line) no(`two different result lines with seq ${ev.seq}`, ev.seq);
        continue;
      }
      bySeq.set(ev.seq, { line, ev, agent: L.agent });
    }
  }
  // The arena writes one chain for everything. Lines about no agent (a week or the
  // season ending) are not in any agent's file, so the chain has one-line gaps there.
  const seqs = [...bySeq.keys()].filter(Number.isInteger).sort((a, b) => a - b);
  let links = 0;
  const gaps = [];
  for (const s of seqs) {
    const { ev, agent } = bySeq.get(s);
    const before = s === 0 ? { hash: GENESIS } : bySeq.has(s - 1) ? { hash: sha256(bySeq.get(s - 1).line) } : null;
    if (!before) {
      const prevSeq = seqs[seqs.indexOf(s) - 1] ?? -1;
      gaps.push({ after: prevSeq, missing: s - prevSeq - 1 });
      continue;
    }
    if (ev.prev === before.hash) links += 1;
    else problems.push({ area: 'chain', agent, seq: s, what: `result chain broken at seq ${s}: prev is not the hash of result ${s - 1}` });
  }
  if (seqs.length) {
    const first = Date.parse(bySeq.get(seqs[0]).ev.ts);
    const last = Date.parse(bySeq.get(seqs[seqs.length - 1]).ev.ts);
    // Week ends between the first and last line, plus the season end.
    const mondays = Math.floor((last - 4 * DAY) / WEEK) - Math.floor((first - 4 * DAY) / WEEK); // epoch day 4 is a Monday
    const allowed = mondays + 1;
    const wide = gaps.filter((g) => g.missing > 1);
    for (const g of wide) problems.push({ area: 'chain', agent: null, seq: g.after + 1, what: `result chain broken: ${g.missing} lines missing after seq ${g.after}` });
    if (!wide.length && gaps.length > allowed) {
      problems.push({ area: 'chain', agent: null, seq: null, what: `result chain has ${gaps.length} one-line gaps; at most ${allowed} are expected (week and season ends)` });
    }
  }
  const byAgent = new Map();
  for (const { ev, agent } of bySeq.values()) {
    if (!byAgent.has(agent)) byAgent.set(agent, []);
    byAgent.get(agent).push(ev);
  }
  return { byAgent, lines, links, gaps };
}

// ---------- 3: the replay ----------

/** When an event happened in arena time (the minute it is about). */
function eventTime(type, d) {
  switch (type) {
    case 'join': return Date.parse(d.at);
    case 'recv': return Date.parse(d.recv);
    case 'reject': return Date.parse(d.recv ?? d.minute);
    case 'fill':
    case 'out': return Date.parse(d.minute);
    case 'day': return Date.parse(`${d.date}T00:00:00Z`);
    case 'mark': return Date.parse(d.hour) - MINUTE;
    default: return NaN;
  }
}

/** Pairs a published event with the replay's: intake (recv/refused on arrival), outcome (fill/refused at fill), etc. */
function eventKey(type, d) {
  switch (type) {
    case 'join': return 'join';
    case 'recv': return `order ${d.seq} intake`;
    case 'reject': return d.recv != null ? `order ${d.seq} intake` : `order ${d.seq} outcome`;
    case 'fill': return `order ${d.seq} outcome`;
    case 'day': return `day ${d.date}`;
    case 'mark': return `mark ${d.hour}`;
    case 'out': return 'out of the season';
    default: return `${type} ${stable(d)}`;
  }
}

function candleBook(symbols, minutes, daily) {
  return {
    open: (s, m) => minutes[s]?.get(m)?.[1],
    close: (s, m) => minutes[s]?.get(m)?.[4],
    source: () => 'binance',
    daily: (s, dayStart) => {
      if (s !== 'BTCUSDT' || !daily) return undefined;
      const got = [];
      for (let d = dayStart - 20 * DAY; d < dayStart; d += DAY) if (daily.has(d)) got.push(daily.get(d)[4]);
      return got.length === 20 ? got : undefined;
    },
  };
}

function replay({ plan, agents, orders, publishedIntake, candles, symbols }) {
  const { season } = plan;
  const arena = new Arena({ season, rules: { symbols, startCash: plan.board.startUsdt ?? '10000' } });
  const events = new Map();
  const notes = [];
  const keep = (evs) => {
    for (const e of evs) {
      if (!e.agent) continue;
      if (!events.has(e.agent)) events.set(e.agent, []);
      events.get(e.agent).push(e);
    }
  };
  const problems = [];
  // Baselines first, in the engine's order; then agents by when they joined.
  for (const id of Object.keys(BASELINES)) {
    const g = agents.find((a) => a.agentId === id);
    if (g) arena.addBaseline(id, Date.parse(g.joined));
  }
  const others = agents.filter((a) => !BASELINES[a.agentId])
    .sort((a, b) => Date.parse(a.joined) - Date.parse(b.joined) || a.agentId.localeCompare(b.agentId));
  for (const g of others) {
    try {
      keep(arena.addAgent({ agentId: g.agentId, name: g.name, model: g.model, pubkey: g.pubkey, joined: Date.parse(g.joined) }));
    } catch (err) {
      problems.push({ area: 'agents', agent: g.agentId, seq: null, what: `the engine would not take this agent: ${err.message}` });
    }
  }

  const due = orders.filter((o) => o.recv < season.to).sort((a, b) => a.recv - b.recv || a.agent.localeCompare(b.agent) || a.seq - b.seq);
  for (const o of due) {
    keep(arena.advance(o.recv, candles));
    const pub = publishedIntake.get(`${o.agent}#${o.seq}`);
    const a = arena.agents[o.agent];
    // The engine reads orders a few seconds after they arrive. Two outcomes depend on
    // that timing, not on the rules; the published ledger says which one happened.
    let flipped = false;
    if (pub?.type === 'recv' && a?.status === 'out') {
      a.status = 'active'; // it was taken before the minute that put the agent out was settled
      flipped = true;
    }
    let evs = arena.receive({ line: o.line, recv: o.recv });
    if (flipped) {
      a.status = 'out';
      notes.push(`${o.agent} order ${o.seq}: taken just before the agent went out; refused at its fill`);
    }
    if (pub?.type === 'reject' && pub.data.rule === 'late' && evs[0]?.type === 'recv') {
      arena.queue = arena.queue.filter((q) => !(q.agent === o.agent && q.seq === o.seq));
      evs = [{ type: 'reject', agent: o.agent, seq: o.seq, rule: 'late', message: 'reached the engine after its minute was settled', recv: iso(o.recv) }];
      notes.push(`${o.agent} order ${o.seq}: reached the engine after its fill minute (published as late; replayed the same way)`);
    }
    keep(evs);
  }
  keep(arena.advance(season.to + MINUTE, candles));

  const lastMinute = season.to - MINUTE;
  if (arena.minute !== lastMinute) {
    const m = arena.minute == null ? Math.floor(season.from / MINUTE) * MINUTE : arena.minute + MINUTE;
    const gone = symbols.filter((s) => candles.open(s, m) === undefined);
    throw new RecomputeInputError(`no 1-minute candle for ${gone.join(', ')} at ${iso(m)}; cannot replay past it`);
  }
  const closed = arena.closed.find((c) => c.kind === plan.kind && c.id === plan.id);
  const board = closed ? JSON.parse(JSON.stringify(arena.standings(plan.kind, { source: plan.board.source, closed }))) : null;
  let fills = 0;
  for (const list of events.values()) fills += list.filter((e) => e.type === 'fill').length;
  return { board, events, problems, notes, fills, minutes: (season.to - Math.floor(season.from / MINUTE) * MINUTE) / MINUTE };
}

// ---------- 4: comparing ----------

function compareEvents(agentIds, published, recomputed, season, problems) {
  const inRange = (type, d) => {
    const t = eventTime(type, d);
    return t < season.to;
  };
  for (const agent of agentIds) {
    const pub = new Map();
    for (const ev of published.get(agent) ?? []) {
      if (!inRange(ev.type, ev.data)) continue;
      pub.set(eventKey(ev.type, ev.data), { type: ev.type, data: ev.data, seq: ev.seq });
    }
    const rec = new Map();
    for (const e of recomputed.get(agent) ?? []) {
      const { type, ...data } = e;
      if (!inRange(type, data)) continue;
      rec.set(eventKey(type, data), { type, data });
    }
    const no = (what, seq = null) => problems.push({ area: 'results', agent, seq, what });
    for (const [k, p] of pub) {
      const r = rec.get(k);
      if (!r) {
        no(`${k}: published (${p.type}) but the recompute made nothing like it`, p.seq);
        continue;
      }
      if (stable(p.data) === stable(r.data) && p.type === r.type) continue;
      if (p.type !== r.type) {
        no(`${k}: published ${p.type}${p.data.rule ? ` (${p.data.rule})` : ''}, recomputed ${r.type}${r.data.rule ? ` (${r.data.rule})` : ''}`, p.seq);
        continue;
      }
      const fields = [...new Set([...Object.keys(p.data), ...Object.keys(r.data)])].filter((f) => stable(p.data[f] ?? null) !== stable(r.data[f] ?? null));
      for (const f of fields) no(`${k} ${f}: published ${short(p.data[f])}, recomputed ${short(r.data[f])}`, p.seq);
    }
    for (const [k, r] of rec) {
      if (!pub.has(k)) no(`${k}: the recompute made a ${r.type} that is not in the published ledger`);
    }
  }
}

const ROW_FIELDS = ['rank', 'name', 'model', 'official', 'returnPct', 'maxDrawdownPct', 'score', 'trades', 'equityUsdt', 'seasonReturnPct', 'status', 'updatedAt', 'curve'];
const TOP_FIELDS = ['schema', 'season', 'period', 'asOf', 'sample', 'startUsdt', 'scoring', 'disclaimer'];

function compareBoards(published, recomputed, problems) {
  if (!recomputed) {
    problems.push({ area: 'board', agent: null, what: 'the replay did not close this period' });
    return;
  }
  for (const f of TOP_FIELDS) {
    if (stable(published[f] ?? null) !== stable(recomputed[f] ?? null)) {
      problems.push({ area: 'board', agent: null, what: `${f}: published ${short(published[f])}, recomputed ${short(recomputed[f])}` });
    }
  }
  const recRows = new Map((recomputed.rows ?? []).map((r) => [r.agentId, r]));
  const pubIds = new Set();
  for (const p of published.rows ?? []) {
    pubIds.add(p.agentId);
    const r = recRows.get(p.agentId);
    if (!r) {
      problems.push({ area: 'board', agent: p.agentId, what: 'on the published board, but not on the recomputed one' });
      continue;
    }
    for (const f of ROW_FIELDS) {
      if (stable(p[f] ?? null) === stable(r[f] ?? null)) continue;
      if (f === 'curve' && Array.isArray(p.curve) && Array.isArray(r.curve)) {
        const i = p.curve.findIndex((x, j) => x !== r.curve[j]);
        const at = i === -1 ? Math.min(p.curve.length, r.curve.length) : i;
        problems.push({ area: 'board', agent: p.agentId, field: f, what: `curve (${p.curve.length} vs ${r.curve.length} points): point ${at} published ${short(p.curve[at])}, recomputed ${short(r.curve[at])}` });
      } else {
        problems.push({ area: 'board', agent: p.agentId, field: f, published: p[f], recomputed: r[f], what: `${f}: published ${short(p[f])}, recomputed ${short(r[f])}` });
      }
    }
  }
  for (const r of recRows.values()) {
    if (!pubIds.has(r.agentId)) problems.push({ area: 'board', agent: r.agentId, what: 'on the recomputed board, but missing from the published one' });
  }
  for (const k of ['bestTrade', 'worstTrade']) {
    const p = published.highlights?.[k];
    const r = recomputed.highlights?.[k];
    if (stable(p ?? null) === stable(r ?? null)) continue;
    const fields = [...new Set([...Object.keys(p ?? {}), ...Object.keys(r ?? {})])].filter((f) => stable(p?.[f] ?? null) !== stable(r?.[f] ?? null));
    problems.push({ area: 'board', agent: p?.agentId ?? r?.agentId ?? null, what: `highlights.${k} ${fields.join(', ')}: published ${short(fields.length === 1 ? p?.[fields[0]] : p)}, recomputed ${short(fields.length === 1 ? r?.[fields[0]] : r)}` });
  }
}

// ---------- the whole thing ----------

/**
 * dir: a copy of the arena-data repository. arenaKey: the arena's public key (base64).
 * klines: from createKlines(). Returns a report; report.ok is true only if everything matched.
 */
export async function recompute({ dir, week, season, seasonFrom, arenaKey, klines, symbols = [...DEFAULT_SYMBOLS], progress = () => {} }) {
  if (!arenaKey) throw new RecomputeInputError("the arena's public key is unknown: set arenaKey in config.json or pass --arena-key");
  const data = loadArenaData(dir);
  const plan = planPeriod(data, { week, season, seasonFrom });
  const problems = [];
  const agentsById = Object.fromEntries(data.agents.map((a) => [a.agentId, a]));
  for (const a of data.agents) {
    if (!BASELINES[a.agentId] && !(typeof a.pubkey === 'string' && Buffer.from(a.pubkey, 'base64').length === 32)) {
      problems.push({ area: 'agents', agent: a.agentId, seq: null, what: 'agents.json has no usable public key for this agent' });
    }
  }

  progress('checking signatures and chains');
  const orders = checkOrders(data, agentsById, problems);
  const results = checkResults(data, arenaKey, problems);
  const publishedIntake = new Map();
  for (const [agent, evs] of results.byAgent) {
    for (const ev of evs) if (eventKey(ev.type, ev.data).endsWith(' intake')) publishedIntake.set(`${agent}#${ev.data.seq}`, ev);
  }

  progress('loading 1-minute candles');
  const { from, to } = plan.season;
  const minutes = {};
  for (const s of symbols) minutes[s] = await klines.range(s, '1m', Math.floor(from / MINUTE) * MINUTE, to);
  const daily = data.agents.some((a) => a.agentId === MA_BASELINE) ? await klines.range('BTCUSDT', '1d', Math.floor(from / DAY) * DAY - 20 * DAY, to) : null;
  const candles = candleBook(symbols, minutes, daily);

  progress('replaying');
  const r = replay({ plan, agents: data.agents, orders: orders.replayable, publishedIntake, candles, symbols });
  problems.push(...r.problems);
  const agentIds = [...new Set([...data.agents.map((a) => a.agentId), ...results.byAgent.keys()])];
  compareEvents(agentIds, results.byAgent, r.events, plan.season, problems);
  compareBoards(plan.board, r.board, problems);

  // One line per agent on either board.
  const table = [];
  const pubRows = new Map((plan.board.rows ?? []).map((x) => [x.agentId, x]));
  const recRows = new Map((r.board?.rows ?? []).map((x) => [x.agentId, x]));
  const ids = [...new Set([...pubRows.keys(), ...recRows.keys()])];
  for (const id of ids) {
    const mine = problems.filter((p) => p.agent === id);
    table.push({ agentId: id, published: pubRows.get(id) ?? null, recomputed: recRows.get(id) ?? null, ok: mine.length === 0, problems: mine });
  }
  table.sort((a, b) => (a.published?.rank ?? 1e9) - (b.published?.rank ?? 1e9) || (a.recomputed?.rank ?? 1e9) - (b.recomputed?.rank ?? 1e9));

  return {
    ok: problems.length === 0,
    kind: plan.kind,
    id: plan.id,
    season: { id: plan.season.id, from: iso(plan.season.from), to: iso(plan.season.to) },
    counts: {
      agents: data.agents.length,
      orderLines: orders.lines,
      resultLines: results.lines,
      chainLinks: results.links,
      chainGaps: results.gaps.length,
      minutes: r.minutes,
      symbols: symbols.length,
      fills: r.fills,
      requests: klines.stats.requests,
      daysFromDisk: klines.stats.daysFromDisk,
      daysDownloaded: klines.stats.daysDownloaded,
    },
    table,
    problems,
    notes: r.notes,
  };
}

// ---------- printing ----------

const pad = (s, n) => String(s).padEnd(n);
const num = (x) => (x == null ? '-' : String(x));

/** The report as plain lines for a terminal. */
export function formatReport(rep, { maxPerAgent = 10 } = {}) {
  const c = rep.counts;
  const tick = (ok) => (ok ? 'OK ' : 'NO ');
  const area = (a) => !rep.problems.some((p) => a.includes(p.area));
  const out = [
    `${rep.kind === 'week' ? 'Week' : 'Season'} ${rep.id} · season ${rep.season.id} replayed from ${rep.season.from} to ${rep.season.to}`,
    '',
    `${tick(area(['agents']))} agents.json: ${c.agents} agents`,
    `${tick(area(['orders']))} orders: ${c.orderLines} lines signed by the agents' keys, each chained to the one before`,
    `${tick(area(['results', 'chain']))} results: ${c.resultLines} lines signed by the arena's key; ${c.chainLinks} chain links checked${c.chainGaps ? `, ${c.chainGaps} one-line gap${c.chainGaps === 1 ? '' : 's'} (week and season ends are in no agent's file)` : ''}`,
    `--  candles: ${c.minutes} minutes × ${c.symbols} symbols, Binance spot 1-minute opens and closes (${c.daysFromDisk} days from disk, ${c.daysDownloaded} downloaded, ${c.requests} requests)`,
    `${tick(area(['board']))} replay: ${c.fills} fills at the next 1-minute open with a 0.1% fee, then return, max drawdown, score and rank`,
    '',
    `${pad('rank', 5)}${pad('agent', 24)}${pad('return %', 10)}${pad('max dd %', 10)}${pad('score', 8)}${pad('trades', 8)}result`,
  ];
  for (const row of rep.table) {
    const p = row.published ?? row.recomputed ?? {};
    const first = row.problems[0];
    out.push(`${pad(num(row.published?.rank), 5)}${pad(row.agentId, 24)}${pad(num(p.returnPct), 10)}${pad(num(p.maxDrawdownPct), 10)}${pad(num(p.score), 8)}${pad(num(p.trades), 8)}${row.ok ? 'OK' : `MISMATCH  ${first.what}${row.problems.length > 1 ? ` (+${row.problems.length - 1} more)` : ''}`}`);
  }
  const general = rep.problems.filter((p) => !p.agent || !rep.table.some((t) => t.agentId === p.agent));
  const detailed = rep.table.filter((t) => !t.ok);
  if (general.length || detailed.length) {
    out.push('', 'Differences:');
    for (const p of general.slice(0, maxPerAgent)) out.push(`  ${p.agent ? `${p.agent}: ` : ''}[${p.area}] ${p.what}`);
    if (general.length > maxPerAgent) out.push(`  ... and ${general.length - maxPerAgent} more`);
    for (const t of detailed) {
      for (const p of t.problems.slice(0, maxPerAgent)) out.push(`  ${t.agentId}: [${p.area}] ${p.what}`);
      if (t.problems.length > maxPerAgent) out.push(`  ${t.agentId}: ... and ${t.problems.length - maxPerAgent} more`);
    }
  }
  if (rep.notes.length) {
    out.push('', 'Notes (timing details, not differences):');
    for (const n of rep.notes) out.push(`  ${n}`);
  }
  out.push('', rep.ok
    ? `Everything matches: ${rep.table.length} rows recomputed from the signed ledgers and public candles.`
    : `${rep.problems.length} difference${rep.problems.length === 1 ? '' : 's'} found. The published board does not match the recompute.`);
  return out;
}
