#!/usr/bin/env node
// A scripted stand-in for an AI agent, for the terminal demo (demo/guard-demo.tape).
// It does what an agent app does when its model calls a tool: start the guard's MCP
// server (`tal serve`, the real code in ../guard), say hello, call one tool, print the
// answer. No model, no network of its own; prices come from wherever the guard gets
// them (set TAL_OFFLINE=1 for the guard's made-up demo prices).
//
//   node demo/agent.mjs place_order symbol=BTC side=buy usdt=500 reason="Small first position."
//   node demo/agent.mjs account
//
// Prints the guard's answer as it came back: a REJECTED line exactly as the guard wrote
// it, otherwise one "key: value" line per field of the JSON reply.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const TAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'guard', 'bin', 'tal.js');

/** `key=value` words → arguments object. Plain numbers become numbers. */
export function parseArgs(words) {
  const out = {};
  for (const w of words) {
    const i = w.indexOf('=');
    if (i < 1) throw new Error(`expected key=value, got: ${w}`);
    const k = w.slice(0, i);
    const v = w.slice(i + 1);
    out[k] = /^\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  return out;
}

/** Call one tool on a fresh `tal serve`; resolves with the tools/call result. */
export function callTool(tool, args, { env = process.env, bin = TAL } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, 'serve'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let done = false;
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (!done) reject(new Error(`guard exited (${code}) before answering${stderr ? `: ${stderr.trim()}` : ''}`));
    });
    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    createInterface({ input: child.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id === 1) {
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } });
      } else if (msg.id === 2) {
        done = true;
        child.stdin.end();
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'demo-agent', version: '0' } },
    });
  });
}

/** The lines to print for one tools/call result. */
export function formatResult(result, { color = false } = {}) {
  const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const text = String(result?.content?.[0]?.text ?? '');
  if (result?.isError) return [paint('31', text)];
  const [first] = text.split('\n');
  if (first.startsWith('REJECTED')) return [paint('1;31', `✗ ${first}`)];
  let obj;
  try { obj = JSON.parse(text); } catch { return [text]; }
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && typeof v === 'object') continue;
    const line = `${k}: ${v}`;
    lines.push(k === 'status' && v === 'accepted' ? paint('1;32', `✓ ${line}`) : `  ${line}`);
  }
  return lines;
}

async function main(argv) {
  const [tool, ...rest] = argv;
  if (!tool) {
    process.stderr.write('usage: agent.mjs TOOL [key=value ...]\n');
    return 2;
  }
  const result = await callTool(tool, parseArgs(rest));
  for (const line of formatResult(result, { color: Boolean(process.stdout.isTTY) })) process.stdout.write(`${line}\n`);
  return result?.isError ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`agent: ${err.message}\n`);
    process.exitCode = 1;
  });
}
