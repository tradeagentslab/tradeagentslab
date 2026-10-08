// Public market data: candles from one exchange's public API (Binance spot by
// default). There is no fallback to another exchange: if the chosen source can't
// be reached, the caller gets a clear error. No keys, no accounts. Prices stay
// strings until money.js parses them.

const HOSTS = {
  binance: 'https://data-api.binance.vision',
  okx: 'https://www.okx.com',
};

export const INTERVALS = Object.freeze({
  '1m': 60_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
});
const OKX_BAR = { '1m': '1m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1Dutc' };

const okxInst = (symbol) => `${symbol.slice(0, -4)}-USDT`;

/**
 * source: 'binance' | 'okx' — the only place asked; never the other one.
 * fetchImpl: injectable for tests. now: clock.
 */
export function createMarket({ source = 'binance', fetchImpl = globalThis.fetch, userAgent = 'guard', now = Date.now, cacheMs = 5000, hosts = HOSTS } = {}) {
  if (!['binance', 'okx'].includes(source)) throw new RangeError('source must be binance or okx');
  const cache = new Map();

  let lastAt = 0; // when the newest answer was actually fetched (cache hits keep the old time)

  async function getJson(url) {
    const hit = cache.get(url);
    if (hit && now() - hit.at < cacheMs) {
      lastAt = hit.at;
      return hit.body;
    }
    const res = await fetchImpl(url, {
      headers: { 'user-agent': userAgent, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    const body = await res.json();
    lastAt = now();
    cache.set(url, { at: lastAt, body });
    return body;
  }

  // Each returns candles oldest → newest: { t: open ms, o, h, l, c, v } (prices as strings).
  const fetchers = {
    async binance(symbol, interval, { startTime, limit }) {
      const q = new URLSearchParams({ symbol, interval, limit: String(limit) });
      if (startTime != null) q.set('startTime', String(startTime));
      const rows = await getJson(`${hosts.binance}/api/v3/klines?${q}`);
      if (!Array.isArray(rows)) throw new Error('binance: unexpected klines reply');
      return rows.map((r) => ({ t: Number(r[0]), o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
    },
    async okx(symbol, interval, { startTime, limit }) {
      const q = new URLSearchParams({ instId: okxInst(symbol), bar: OKX_BAR[interval], limit: String(limit) });
      // OKX pages backwards: `after` = older than. To start at startTime, ask for
      // candles older than startTime + limit bars and keep the ones at or after it.
      if (startTime != null) q.set('after', String(startTime + limit * INTERVALS[interval]));
      // `candles` only keeps the newest 1,440 bars; older ones live in `history-candles`.
      const old = startTime != null && now() - startTime > 1400 * INTERVALS[interval];
      const path = old ? 'history-candles' : 'candles';
      const body = await getJson(`${hosts.okx}/api/v5/market/${path}?${q}`);
      if (body?.code !== '0' || !Array.isArray(body.data)) throw new Error(`okx: ${body?.msg || 'unexpected reply'}`);
      return body.data
        .map((r) => ({ t: Number(r[0]), o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }))
        .filter((k) => startTime == null || k.t >= startTime)
        .sort((a, b) => a.t - b.t);
    },
  };

  async function candles(symbol, interval = '1m', { startTime = null, limit = 1 } = {}) {
    if (!INTERVALS[interval]) throw new RangeError(`interval must be one of ${Object.keys(INTERVALS).join(', ')}`);
    try {
      return { source, candles: await fetchers[source](symbol, interval, { startTime, limit }) };
    } catch (err) {
      // Errors that carry meaning for the caller (rate limits, bans) pass through untouched.
      if (err?.gate) throw err;
      throw new Error(`no market data for ${symbol}: ${err?.message}`);
    }
  }

  return {
    candles,

    /** Latest trade price for each symbol, from the newest 1-minute candle. */
    async latest(symbols) {
      const out = {};
      for (const s of symbols) {
        const { source: src, candles: ks } = await candles(s, '1m', { limit: 1 });
        if (!ks.length) throw new Error(`no price for ${s}`);
        out[s] = { price: ks[ks.length - 1].c, time: lastAt, source: src };
      }
      return out;
    },

    /**
     * Open price of the 1-minute candle that opens at `openTime`, or null if that
     * minute has not started yet. This is the fill price for paper orders.
     */
    async openAt(symbol, openTime) {
      if (now() < openTime) return null;
      const { source: src, candles: ks } = await candles(symbol, '1m', { startTime: openTime, limit: 1 });
      const k = ks.find((c) => c.t === openTime);
      return k ? { price: k.o, source: src } : null;
    },
  };
}

/** The open time of the first 1-minute candle strictly after `ms`. */
export function nextMinute(ms) {
  return Math.floor(ms / 60_000) * 60_000 + 60_000;
}

const DEMO_BASE = { BTC: 65000, ETH: 2500, SOL: 150, BNB: 600, XRP: 0.6, DOGE: 0.12 };

/**
 * Made-up prices that move smoothly and repeat exactly: for demos, screen
 * recordings and development without touching any exchange. Every answer is
 * tagged source "offline-demo" so it can never pass for real data.
 */
export function createOfflineMarket({ now = Date.now } = {}) {
  const priceAt = (symbol, t) => {
    const base = DEMO_BASE[symbol.slice(0, -4)] ?? 10;
    const seed = [...symbol].reduce((a, ch) => a + ch.charCodeAt(0), 0);
    const wave = 0.03 * Math.sin(t / 10_800_000 + seed) + 0.01 * Math.sin(t / 1_020_000 + seed * 3);
    return (base * (1 + wave)).toFixed(base < 1 ? 6 : 2);
  };
  const candle = (symbol, t, step) => {
    const end = Math.min(t + step - 1, now()); // the newest candle is still forming
    const o = priceAt(symbol, t);
    const c = priceAt(symbol, end);
    const mid = priceAt(symbol, t + (end - t) / 2);
    const nums = [o, c, mid].map(Number);
    return { t, o, h: String(Math.max(...nums)), l: String(Math.min(...nums)), c, v: '0' };
  };
  return {
    async candles(symbol, interval = '1m', { startTime = null, limit = 1 } = {}) {
      const step = INTERVALS[interval];
      if (!step) throw new RangeError(`interval must be one of ${Object.keys(INTERVALS).join(', ')}`);
      const last = Math.floor(now() / step) * step;
      const first = startTime ?? last - (limit - 1) * step;
      const out = [];
      for (let t = first; t <= last && out.length < limit; t += step) out.push(candle(symbol, t, step));
      return { source: 'offline-demo', candles: out };
    },
    async latest(symbols) {
      return Object.fromEntries(symbols.map((s) => [s, { price: priceAt(s, now()), time: now(), source: 'offline-demo' }]));
    },
    async openAt(symbol, openTime) {
      return now() < openTime ? null : { price: priceAt(symbol, openTime), source: 'offline-demo' };
    },
  };
}
