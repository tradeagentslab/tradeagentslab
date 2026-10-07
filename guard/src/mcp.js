// A small MCP server over stdio (JSON-RPC 2.0, one message per line).
// Written by hand so the guard has no dependencies: initialize, ping,
// tools/list and tools/call are all an agent needs here.

import { createInterface } from 'node:readline';

import { BRAND } from './brand.js';

export const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

const amount = { anyOf: [{ type: 'number' }, { type: 'string' }] };

export const TOOLS = Object.freeze([
  {
    name: 'market',
    description: 'Prices and recent candles (Binance spot public data; OKX if Binance can\'t be reached). Read-only. Look before you decide.',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: { type: 'array', items: { type: 'string' }, description: 'e.g. ["BTCUSDT"]. Default: all tradable symbols.' },
        interval: { type: 'string', enum: ['1m', '15m', '1h', '4h', '1d'], default: '1h' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 24 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    call: (g, a) => g.marketData(a),
  },
  {
    name: 'account',
    description: 'Your simulated account: cash, equity, positions, pending orders, today\'s P&L and how many orders you have left. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    call: (g) => g.account(),
  },
  {
    name: 'place_order',
    description: 'Place a simulated spot market order. It fills at the open of the next 1-minute candle, fee 0.1%. '
      + 'Locks: whitelisted symbols only; one order at least 10 USDT and at most 10% of equity; one coin at most 30%; after a 5% loss in a UTC day, sells only; '
      + 'at most 12 orders an hour and 60 a day. A short reason is required; it is written to a signed ledger that others can read.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'e.g. BTCUSDT (BTC also works).' },
        side: { type: 'string', enum: ['buy', 'sell'] },
        usdt: { ...amount, description: 'Buy: USDT to spend. Sell: roughly how many USDT worth to sell.' },
        qty: { anyOf: [{ type: 'number' }, { type: 'string' }], description: 'Sell only: coin amount, or "all".' },
        reason: { type: 'string', maxLength: 280, description: 'One or two sentences: why this trade, why now.' },
      },
      required: ['symbol', 'side', 'reason'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    call: (g, a) => g.placeOrder(a, 'agent'),
  },
  {
    name: 'cancel_order',
    description: 'Cancel a pending (not yet filled) order by id, or every pending order with id "all".',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    call: (g, a) => g.cancelOrder(a),
  },
  {
    name: 'fills',
    description: 'Your most recent fills, newest first. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    call: (g, a) => g.fills(a),
  },
  {
    name: 'rules',
    description: 'The locks, the tradable symbols and the pricing rule in force right now. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    call: (g) => g.rules(),
  },
  {
    name: 'halt',
    description: 'Emergency stop. Cancels pending orders and blocks all new ones. Use it when something looks wrong: '
      + 'losses running, a loop, data that makes no sense. Only a person can resume.',
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string', maxLength: 280 } },
      required: ['reason'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    call: (g, a) => g.halt(a, 'agent'),
  },
  {
    name: 'journal',
    description: 'Write one line into your signed ledger: what you saw, decided or learned. Good after every session.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', maxLength: 500 } },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    call: (g, a) => g.journal(a),
  },
]);

export const INSTRUCTIONS = `${BRAND.name} Guard: simulated (paper) spot trading only. `
  + 'There is no real money and no exchange account behind these tools. '
  + 'Every trade goes through place_order, which checks the locks and writes a signed ledger. '
  + 'Never ask the user for exchange API keys or passwords, never call exchange APIs directly, '
  + `and never edit files under ~/.${BRAND.short}. If something looks wrong, call halt.`;

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/** Pure request handler, so tests can drive it without stdio. */
export function createServer({ guard, version }) {
  async function one(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return fail(msg?.id ?? null, -32600, 'Invalid Request');
    }
    const isNotification = !('id' in msg);
    const { id, method, params = {} } = msg;
    if (isNotification) return null;

    switch (method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        return ok(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: BRAND.mcpName, version },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: TOOLS.map(({ call, ...t }) => t) });
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) return fail(id, -32602, `Unknown tool: ${params.name}`);
        const args = params.arguments ?? {};
        if (typeof args !== 'object' || Array.isArray(args)) return fail(id, -32602, 'arguments must be an object');
        try {
          const result = await tool.call(guard, args);
          const rejected = result?.status === 'rejected';
          const text = (rejected ? `REJECTED (${result.rule}): ${result.message}\n` : '') + JSON.stringify(result, null, 2);
          return ok(id, { content: [{ type: 'text', text }], isError: false });
        } catch (err) {
          return ok(id, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
        }
      }
      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  }

  return {
    async handle(msg) {
      if (Array.isArray(msg)) {
        const out = (await Promise.all(msg.map(one))).filter(Boolean);
        return out.length ? out : null;
      }
      return one(msg);
    },
  };
}

/** Serve over stdin/stdout. Logs go to stderr: stdout belongs to the protocol. */
export function serveStdio(server, { input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const write = (obj) => output.write(`${JSON.stringify(obj)}\n`);
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      write(fail(null, -32700, 'Parse error'));
      return;
    }
    const res = await server.handle(msg);
    if (res) write(res);
  });
  return new Promise((resolve) => rl.on('close', resolve));
}
