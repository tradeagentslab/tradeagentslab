import assert from 'node:assert/strict';
import test from 'node:test';

import { createMarket, createOfflineMarket, nextMinute } from '../src/market.js';

const T = Date.parse('2026-10-08T12:00:30Z');
const M = (iso) => Date.parse(iso);

// A pretend network: answers by URL pattern, records what was asked.
function fakeFetch(routes) {
  const asked = [];
  const f = async (url) => {
    asked.push(url);
    for (const [re, body, status = 200] of routes) {
      if (re.test(url)) return { ok: status === 200, status, json: async () => body };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  f.asked = asked;
  return f;
}

const binanceRow = (t, o, c) => [t, o, o, c, c, '12.5', t + 59_999, '0', 1, '0', '0', '0'];

test('binance candles parse oldest → newest, prices stay strings', async () => {
  const fetch = fakeFetch([[/data-api\.binance\.vision\/api\/v3\/klines/, [
    binanceRow(M('2026-10-08T12:00:00Z'), '65000.01000000', '65010.00000000'),
  ]]]);
  const m = createMarket({ fetchImpl: fetch, now: () => T });
  const { source, candles } = await m.candles('BTCUSDT', '1m', { limit: 1 });
  assert.equal(source, 'binance');
  assert.deepEqual(candles[0], { t: M('2026-10-08T12:00:00Z'), o: '65000.01000000', h: '65000.01000000', l: '65010.00000000', c: '65010.00000000', v: '12.5' });
  assert.match(fetch.asked[0], /symbol=BTCUSDT&interval=1m&limit=1/);
});

test('openAt asks for the exact minute and returns its open', async () => {
  const t = M('2026-10-08T12:01:00Z');
  const fetch = fakeFetch([[/startTime=/, [binanceRow(t, '65100.5', '65120')]]]);
  const m = createMarket({ fetchImpl: fetch, now: () => t + 3000 });
  assert.deepEqual(await m.openAt('BTCUSDT', t), { price: '65100.5', source: 'binance' });
  assert.match(fetch.asked[0], new RegExp(`startTime=${t}`));
});

test('openAt before the minute starts is null, without asking anyone', async () => {
  const fetch = fakeFetch([]);
  const m = createMarket({ fetchImpl: fetch, now: () => T });
  assert.equal(await m.openAt('BTCUSDT', nextMinute(T)), null);
  assert.equal(fetch.asked.length, 0);
});

test('binance down → OKX answers; OKX rows are newest first and get sorted', async () => {
  const t1 = M('2026-10-08T12:00:00Z');
  const fetch = fakeFetch([
    [/binance/, {}, 451],
    [/okx\.com\/api\/v5\/market\/candles\?instId=BTC-USDT&bar=1m&limit=2/, {
      code: '0', msg: '', data: [[String(t1 + 60_000), '2', '2', '2', '2', '1'], [String(t1), '1', '1', '1', '1', '1']],
    }],
  ]);
  const m = createMarket({ fetchImpl: fetch, now: () => T });
  const r = await m.candles('BTCUSDT', '1m', { limit: 2 });
  assert.equal(r.source, 'okx');
  assert.deepEqual(r.candles.map((k) => k.o), ['1', '2']);
});

test('OKX openAt pages with `after` and keeps only the asked minute', async () => {
  const t = M('2026-10-08T12:01:00Z');
  const fetch = fakeFetch([
    [/binance/, {}, 500],
    [new RegExp(`okx.*candles\\?instId=ETH-USDT&bar=1m&limit=1&after=${t + 60_000}`), { code: '0', data: [[String(t), '2500.1', '1', '1', '1', '1']] }],
  ]);
  const m = createMarket({ fetchImpl: fetch, now: () => t + 3000 });
  assert.deepEqual(await m.openAt('ETHUSDT', t), { price: '2500.1', source: 'okx' });
});

test('both down → one clear error', async () => {
  const m = createMarket({ fetchImpl: fakeFetch([[/./, {}, 503]]), now: () => T });
  await assert.rejects(m.latest(['BTCUSDT']), /no market data for BTCUSDT/);
});

test('answers are cached for a few seconds', async () => {
  let now = T;
  const fetch = fakeFetch([[/binance/, [binanceRow(M('2026-10-08T12:00:00Z'), '1', '1')]]]);
  const m = createMarket({ fetchImpl: fetch, now: () => now });
  const a = await m.latest(['BTCUSDT']);
  now += 2000;
  const b = await m.latest(['BTCUSDT']);
  assert.equal(fetch.asked.length, 1);
  assert.equal(b.BTCUSDT.time, a.BTCUSDT.time, 'a cached price keeps its original time');
  now += 10_000;
  await m.latest(['BTCUSDT']);
  assert.equal(fetch.asked.length, 2);
});

test('nextMinute is strictly after', () => {
  assert.equal(nextMinute(M('2026-10-08T12:00:30Z')), M('2026-10-08T12:01:00Z'));
  assert.equal(nextMinute(M('2026-10-08T12:01:00Z')), M('2026-10-08T12:02:00Z'));
});

test('offline demo market: repeatable, labelled, never pretends to be real', async () => {
  const m = createOfflineMarket({ now: () => T });
  const a = await m.latest(['BTCUSDT']);
  const b = await createOfflineMarket({ now: () => T }).latest(['BTCUSDT']);
  assert.equal(a.BTCUSDT.price, b.BTCUSDT.price);
  assert.equal(a.BTCUSDT.source, 'offline-demo');
  const { candles } = await m.candles('ETHUSDT', '1h', { limit: 24 });
  assert.equal(candles.length, 24);
  assert.equal((await m.openAt('BTCUSDT', nextMinute(T))), null);
});
