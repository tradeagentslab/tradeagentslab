// The `tal` command: what a person uses. Agents use the MCP tools instead.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { ArenaGuard } from './arena-guard.js';
import { BRAND, ENV_HOME } from './brand.js';
import { homeDir, loadConfig, pathsFor, saveConfig } from './config.js';
import { Guard } from './guard.js';
import { applySteps, describe, detectClients, planInstall, planUninstall } from './install.js';
import { loadOrCreateKey, publicRaw } from './keys.js';
import { Ledger, verifyLedger } from './ledger.js';
import { createMarket, createOfflineMarket } from './market.js';
import { createServer, serveStdio } from './mcp.js';

const PKG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
export const VERSION = PKG.version;
const OFFLINE_ENV = `${BRAND.short.toUpperCase()}_OFFLINE`;

const T = {
  en: {
    help: `${BRAND.name} Guard ${VERSION}: paper trading with locks, a kill switch and a signed ledger.

  ${BRAND.short} init [--agent NAME] [--only claude,codex,openclaw] [--dry-run]
                     register the guard with your agent apps and install the template
  ${BRAND.short} status            account, positions, today's P&L
  ${BRAND.short} halt [--flatten] [--reason TEXT]
                     stop all trading now (--flatten also sells everything)
  ${BRAND.short} resume            lift a halt (asks you to type yes)
  ${BRAND.short} limits            show the locks
  ${BRAND.short} limits set KEY=VALUE ...   change locks (asks you to type yes)
  ${BRAND.short} verify            check the ledger chain and signatures
  ${BRAND.short} replay [--date YYYY-MM-DD]   the day's ledger, line by line
  ${BRAND.short} arena join --name NAME --model MODEL   what to send to sign up for the arena
  ${BRAND.short} venue [paper|arena]  show or switch where orders go (asks you to type yes)
  ${BRAND.short} uninstall [--dry-run]       remove it from your apps (keeps your ledger)
  ${BRAND.short} serve             (the apps run this) MCP server on stdio`,
    needTty: 'This step needs a person at a terminal. Run it yourself in Terminal.',
    typeYes: 'Type yes to confirm: ',
    cancelled: 'Cancelled.',
    noApps: 'No agent app found (claude, codex, openclaw). Install one first, or pass --only.',
    done: `Done. Paper trading, no keys needed. Restart your agent app, then try: "use ${BRAND.mcpName} to look at BTC and paper-buy 100 USDT".`,
    step0: `No exchange account is needed for paper trading. Later, to practise on an exchange testnet: step 0 → ${BRAND.site}/en/account/`,
    halted: 'HALTED',
    running: 'running',
    equity: 'equity', start: 'start', today: 'today', cash: 'cash', free: 'free',
    pending: 'pending', left: (h, d) => `orders left: ${h} this hour, ${d} today`,
    join: `Sign up: open an issue in the arena repository (${BRAND.site}/en/arena/) and paste the JSON above. It holds only your public key; never send anything else. Once you are in, switch with: ${BRAND.short} venue arena`,
    globalHint: `To use ${BRAND.short} in a terminal: npm i -g ${BRAND.npm} (or run npx -y ${BRAND.npm} <command>).`,
    kept: (root) => `Kept your ledger and keys in ${root}.`,
    selling: 'selling',
    verified: (n) => `✓ ${n} lines, chain and signatures OK`,
    broken: (r) => `✗ ${r.file} line ${r.line}: ${r.reason}`,
    nothingToSet: 'nothing to set; e.g. limits set max_order_pct=5',
    unknown: (c) => `unknown command: ${c}`,
    joinUsage: `usage: ${BRAND.short} arena join --name NAME --model MODEL`,
  },
  zh: {
    help: `${BRAND.name} 安全壳 ${VERSION}：模拟盘，带锁、急停和签名账本。

  ${BRAND.short} init [--agent 名字] [--only claude,codex,openclaw] [--dry-run]
                     登记进你装的代理软件，顺便装零代码模板
  ${BRAND.short} status            账户、持仓、今天盈亏
  ${BRAND.short} halt [--flatten] [--reason 理由]
                     马上停止交易（加 --flatten 把持仓全部卖掉）
  ${BRAND.short} resume            解除急停（要你打字确认）
  ${BRAND.short} limits            看锁
  ${BRAND.short} limits set 键=值 ...      改锁（要你打字确认）
  ${BRAND.short} verify            核对账本的链和签名
  ${BRAND.short} replay [--date YYYY-MM-DD]   按时间回放那一天的账本
  ${BRAND.short} arena join --name 名字 --model 模型   报名擂台要发的内容
  ${BRAND.short} venue [paper|arena]  看或换单子发到哪（要你打字确认）
  ${BRAND.short} uninstall [--dry-run]       从代理软件里删掉（账本留着）
  ${BRAND.short} serve             （代理软件自己跑）MCP 服务`,
    needTty: '这一步要人在终端里确认。请你自己在“终端”里跑。',
    typeYes: '输入 yes 确认：',
    cancelled: '没改。',
    noApps: '没找到代理软件（claude、codex、openclaw）。先装一个，或者用 --only 指定。',
    done: `装好了。模拟盘，不要任何密钥。重开代理软件，然后对它说：“用 ${BRAND.mcpName} 看看 BTC，模拟买 100 USDT”。`,
    step0: `模拟盘不要交易所账户。以后想用交易所的测试网练真接口，先看第 0 步：${BRAND.site}/zh-hans/account/`,
    halted: '已急停',
    running: '正常',
    equity: '权益', start: '起始', today: '今天', cash: '现金', free: '可用',
    pending: '待成交', left: (h, d) => `本小时还能下 ${h} 单，今天还能下 ${d} 单`,
    join: `报名：到擂台仓库开一个 issue（见 ${BRAND.site}/zh-hans/arena/），贴上面这段 JSON。里面只有你的公钥，别的什么都不要发。报上以后，用这条换成擂台模式：${BRAND.short} venue arena`,
    globalHint: `终端里要用 ${BRAND.short}，先装一次：npm i -g ${BRAND.npm}（或者用 npx -y ${BRAND.npm} 代替 ${BRAND.short}）。`,
    kept: (root) => `账本和钥匙留在 ${root}。`,
    selling: '正在卖出',
    verified: (n) => `✓ ${n} 行，链和签名都对`,
    broken: (r) => `✗ ${r.file} 第 ${r.line} 行：${r.reason}`,
    nothingToSet: '没说要改什么，例如：limits set max_order_pct=5',
    unknown: (c) => `没有这个命令：${c}`,
    joinUsage: `用法：${BRAND.short} arena join --name 名字 --model 模型`,
  },
};

function lang(env) {
  const l = env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
  return /^zh/i.test(l) ? 'zh' : 'en';
}

function which(cmd, env) {
  for (const dir of (env.PATH || '').split(delimiter)) {
    if (dir && existsSync(join(dir, cmd))) return join(dir, cmd);
  }
  return null;
}

export const defaultIo = {
  env: process.env,
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
  isTTY: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask: async (q) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return await rl.question(q); } finally { rl.close(); }
  },
  exec: (bin, args) => spawnSync(bin, args, { encoding: 'utf8' }),
  home: () => homedir(),
  now: () => Date.now(),
  platform: process.platform,
};

const findApps = (io) => detectClients({ which: (c) => which(c, io.env), platform: io.platform ?? process.platform });

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

function makeGuard(io, root, agent) {
  const offline = io.env[OFFLINE_ENV] === '1';
  const cfg = loadConfig(root);
  const market = offline
    ? createOfflineMarket({ now: io.now })
    : createMarket({ source: cfg.price_source, userAgent: `${BRAND.mcpName}/${VERSION}`, now: io.now });
  return cfg.venue === 'arena'
    ? new ArenaGuard({ root, market, now: io.now, agent, fetchImpl: io.fetch ?? globalThis.fetch })
    : new Guard({ root, market, now: io.now, agent });
}

async function confirm(io, t, what) {
  if (!io.isTTY()) {
    io.err(t.needTty);
    return false;
  }
  io.out(what);
  const ans = await io.ask(t.typeYes);
  if (String(ans).trim().toLowerCase() !== 'yes') {
    io.out(t.cancelled);
    return false;
  }
  return true;
}

function printArenaAccount(io, t, a) {
  io.out(`${BRAND.name} · ${a.agentId} · arena · ${a.status}${a.halted_here ? ` · ${t.halted} (${a.halted_here.reason})` : ''}`);
  io.out(`${t.equity} ${a.equityUsdt} USDT (${t.start} ${a.startUsdt}, ${a.seasonReturnPct}%)${a.today ? ` · ${t.today} ${a.today.returnPct}%` : ''}`);
  io.out(`${t.cash} ${a.cashUsdt}`);
  for (const p of a.positions) io.out(`  ${p.symbol} ${p.qty} × ${p.price} = ${p.valueUsdt}`);
  for (const o of a.pendingOrders) io.out(`  ${t.pending} #${o.seq} ${o.side} ${o.symbol} ${o.usdt ?? o.qty} → ${o.fillsAt}`);
  io.out(t.left(a.ordersLeft.thisHour, a.ordersLeft.today));
}

function printAccount(io, t, a) {
  const state = a.halted ? `${t.halted} (${a.halted.reason}, ${a.halted.by})` : t.running;
  io.out(`${BRAND.name} · ${a.agent} · ${a.venue} · ${state}`);
  io.out(`${t.equity} ${a.equity_usdt} USDT (${t.start} ${a.start_usdt}, ${a.pnl_pct}%)${a.today ? ` · ${t.today} ${a.today.pnl_pct}%` : ''}`);
  io.out(`${t.cash} ${a.cash_usdt} (${t.free} ${a.free_cash_usdt})`);
  for (const p of a.positions) io.out(`  ${p.symbol} ${p.qty} × ${p.price} = ${p.value_usdt} (${p.pct_of_equity}%)`);
  for (const o of a.pending_orders) io.out(`  ${t.pending} ${o.id} ${o.side} ${o.symbol} ${o.usdt ?? o.qty} → ${o.fills_at}`);
  io.out(t.left(a.orders_left.this_hour, a.orders_left.today));
}

export async function main(argv, io = defaultIo) {
  const t = T[lang(io.env)];
  const f = flags(argv);
  const cmd = f._[0] ?? 'help';
  const root = io.env[ENV_HOME] || homeDir(io.env);

  try {
    switch (cmd) {
      case 'help':
      case '--help':
        io.out(t.help);
        return 0;

      case 'version':
      case '--version':
        io.out(VERSION);
        return 0;

      case 'init': {
        const clients = findApps(io);
        const only = typeof f.only === 'string' ? f.only.split(',') : undefined;
        const steps = planInstall({
          clients, home: io.home(), root, agent: typeof f.agent === 'string' ? f.agent : 'my-agent',
          version: VERSION, localBin: f.local ? fileURLToPath(new URL('../bin/tal.js', import.meta.url)) : undefined, only,
        });
        if (!steps.some((s) => s.kind === 'exec')) io.err(t.noApps);
        if (f['dry-run']) {
          for (const s of steps) if (!s.quiet) io.out(`· ${describe(s)}`);
          return 0;
        }
        const report = applySteps(steps, { exec: io.exec });
        for (const r of report) io.out(`${r.ok ? '✓' : '✗'} ${describe(r.step)}${r.ok ? '' : ` — ${r.note}`}`);
        io.out(t.done);
        io.out(t.globalHint);
        io.out(t.step0);
        return report.every((r) => r.ok) ? 0 : 1;
      }

      case 'uninstall': {
        const clients = findApps(io);
        const steps = planUninstall({ clients, home: io.home() });
        if (f['dry-run']) {
          for (const s of steps) io.out(`· ${describe(s)}`);
          return 0;
        }
        for (const r of applySteps(steps, { exec: io.exec })) io.out(`✓ ${describe(r.step)}`);
        io.out(t.kept(root));
        return 0;
      }

      case 'serve': {
        const guard = makeGuard(io, root, typeof f.agent === 'string' ? f.agent : undefined);
        await serveStdio(createServer({ guard, version: VERSION }));
        return 0;
      }

      case 'status': {
        const a = await makeGuard(io, root).account();
        if (a.venue === 'arena') printArenaAccount(io, t, a);
        else printAccount(io, t, a);
        return 0;
      }

      case 'venue': {
        const cfg = loadConfig(root);
        const next = f._[1];
        if (!next) {
          io.out(cfg.venue);
          return 0;
        }
        if (!(await confirm(io, t, `${cfg.venue} → ${next}`))) return 1;
        saveConfig(root, { ...cfg, venue: next });
        io.out(next);
        return 0;
      }

      case 'arena': {
        if (f._[1] !== 'join' || typeof f.name !== 'string' || typeof f.model !== 'string') throw new Error(t.joinUsage);
        const cfg = loadConfig(root);
        const p = pathsFor(root, cfg.agent);
        const entry = { agentId: cfg.agent, name: f.name, model: f.model, official: false, pubkey: publicRaw(loadOrCreateKey(p.key)) };
        io.out(JSON.stringify(entry, null, 2));
        io.out(t.join);
        return 0;
      }

      case 'halt': {
        const r = await makeGuard(io, root).halt({ reason: typeof f.reason === 'string' ? f.reason : 'halted from the terminal' }, 'human', { flatten: Boolean(f.flatten) });
        io.out(`${t.halted}: ${r.halted.reason}${r.flatten_orders.length ? ` · ${t.selling}: ${r.flatten_orders.join(', ')}` : ''}`);
        return 0;
      }

      case 'resume': {
        const guard = makeGuard(io, root);
        const a = await guard.account();
        if (!a.halted) {
          io.out(t.running);
          return 0;
        }
        if (!(await confirm(io, t, `${t.halted}: ${a.halted.reason} (by ${a.halted.by}, ${a.halted.ts})`))) return 1;
        await guard.resume();
        io.out(t.running);
        return 0;
      }

      case 'limits': {
        const guard = makeGuard(io, root);
        if (f._[1] !== 'set') {
          const r = await guard.rules();
          io.out(JSON.stringify({ symbols: r.symbols, limits: r.limits, pricing: r.pricing }, null, 2));
          return 0;
        }
        const changes = Object.fromEntries(f._.slice(2).map((kv) => kv.split('=', 2)));
        if (!Object.keys(changes).length) throw new Error(t.nothingToSet);
        if (!(await confirm(io, t, JSON.stringify(changes)))) return 1;
        const r = await guard.setConfig(changes);
        io.out(JSON.stringify({ symbols: r.symbols, limits: r.limits }, null, 2));
        return 0;
      }

      case 'verify': {
        const cfg = loadConfig(root);
        const p = pathsFor(root, typeof f.agent === 'string' ? f.agent : cfg.agent);
        const r = verifyLedger(p.ledger, publicRaw(loadOrCreateKey(p.key)));
        io.out(r.ok ? t.verified(r.count) : t.broken(r));
        return r.ok ? 0 : 1;
      }

      case 'replay': {
        const cfg = loadConfig(root);
        const agent = typeof f.agent === 'string' ? f.agent : cfg.agent;
        const p = pathsFor(root, agent);
        const date = typeof f.date === 'string' ? f.date : new Date(io.now()).toISOString().slice(0, 10);
        const led = new Ledger({ dir: p.ledger, agent, key: loadOrCreateKey(p.key) });
        for (const ev of led.events({ fromDate: date })) {
          if (ev.ts.slice(0, 10) !== date) continue;
          io.out(`${ev.ts.slice(11, 19)}  #${ev.seq} ${ev.type.padEnd(7)} ${summary(ev)}`);
        }
        return 0;
      }

      default:
        io.err(t.unknown(cmd));
        io.out(t.help);
        return 2;
    }
  } catch (err) {
    io.err(`${BRAND.short}: ${err.message}`);
    return 1;
  }
}

function summary(ev) {
  const d = ev.data;
  switch (ev.type) {
    case 'order':
      return `${d.verdict} ${d.side} ${d.symbol} ${d.usdt ?? d.qty ?? ''}${d.rule ? ` [${d.rule}]` : ''} — ${d.reason}`;
    case 'fill':
      return `${d.side} ${d.symbol} ${d.qty} @ ${d.price} (fee ${d.fee})`;
    case 'halt':
      return `by ${d.by}: ${d.reason}`;
    case 'journal':
      return d.text;
    case 'day':
      return `start equity ${d.start_equity}`;
    default:
      return JSON.stringify(d);
  }
}
