// A whole arena world for tests, offline: the Worker on a fake D1, fake candles,
// an engine loop with its own key, and a roster with one house agent.

import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicRaw } from '../../guard/src/keys.js';
import { EngineLoop } from '../engine/main.js';
import { handle } from '../worker/index.js';
import { d1 } from './d1shim.mjs';

export const API = 'https://arena.test/api/arena/v0';
export const T0 = Date.parse('2026-10-28T00:00:00Z');
const BASE = { BTCUSDT: 65000, ETHUSDT: 2500, SOLUSDT: 150, BNBUSDT: 600, XRPUSDT: 0.6, DOGEUSDT: 0.12 };
export const price = (s, t) => (BASE[s] * (1 + 0.001 * (Math.floor(t / 60_000) % 10))).toFixed(BASE[s] < 1 ? 6 : 2);

export function world({ roster: customRoster, baselines = [] } = {}) {
  const clock = { t: T0 + 10_000 };
  const env = { DB: d1([fileURLToPath(new URL('../worker/schema.sql', import.meta.url))]) };
  let dropReply = false;
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith(API)) {
      const res = await handle(new Request(url, init), env, clock.t);
      if (dropReply && init.method === 'POST') {
        dropReply = false;
        throw new Error('connection reset (reply lost)');
      }
      return res;
    }
    const u = new URL(url);
    if (u.host === 'data-api.binance.vision') {
      const q = u.searchParams;
      const step = { '1h': 3_600_000, '1d': 86_400_000 }[q.get('interval')] ?? 60_000;
      const limit = Number(q.get('limit'));
      const now = Math.floor(clock.t / step) * step;
      const start = q.get('startTime') ? Number(q.get('startTime')) : now - (limit - 1) * step;
      const rows = [];
      for (let t = start; t <= now && rows.length < limit; t += step) {
        rows.push([t, price(q.get('symbol'), t), price(q.get('symbol'), t), price(q.get('symbol'), t), price(q.get('symbol'), t + step - 1), '1', t + step - 1]);
      }
      return new Response(JSON.stringify(rows));
    }
    return new Response('{}', { status: 404 });
  };
  const home = mkdtempSync(join(tmpdir(), 'arena-e2e-'));
  const agentKey = generateKeyPairSync('ed25519').privateKey;
  const roster = join(home, 'roster.json');
  writeFileSync(roster, JSON.stringify(customRoster ?? [
    { agentId: 'tal-claude', name: 'Claude', model: 'Model X', official: true, pubkey: publicRaw(agentKey), joined: '2026-10-28T00:00:00Z' },
    { agentId: 'bad-name', name: 'SignalBot', model: 'm', pubkey: publicRaw(agentKey) },
  ]));
  const logs = [];
  const loop = new EngineLoop({
    config: { api: API, home, roster, baselines, season: { id: 'S1', from: T0, to: Date.parse('2026-12-01T00:00:00Z') }, pollSec: 20, priceSource: 'binance', source: 'test arena' },
    fetchImpl, now: () => clock.t, log: (s) => logs.push(s),
  });
  env.ENGINE_PUBKEY = loop.pubkey();
  const get = async (path) => (await fetchImpl(`${API}${path}`)).json();
  return { clock, env, loop, agentKey, logs, get, fetchImpl, loseNextReply: () => { dropReply = true; } };
}
