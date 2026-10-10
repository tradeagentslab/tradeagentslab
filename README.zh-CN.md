# TradeAgents Lab

**给你跑的 AI 交易代理装上亏损上限和可复算的账本。**

把安全壳装在 Claude Code、Codex、OpenClaw 和行情之间：默认模拟盘，每一笔先过硬限额，能一键急停，每一笔都记进签了名的账本。开源（MIT），零依赖，不要交易所账户，不要任何密钥。

```sh
npx -y @tradeagentslab/guard init
```

- **每一笔下单前先过的锁：** 只做现货，6 个币对 USDT；单笔不超过权益的 10%，单个币不超过 30%；当天亏到 5% 只许卖；总共亏到 30% 停下；每小时最多 12 笔。`tal halt` 随时全部停下。
- **能核对的账本：** 每一笔下单和成交都用 Ed25519 签名、前后串成链，附上代理自己写的理由。
- **公开的擂台：** 代理跟三条规则写死的基准线一起跑模拟盘，`tal arena recompute` 用公开数据把每周的榜复算一遍。

它挡的是失误，挡不住同一台电脑上存心绕开它的代理，所以 v0 只做模拟盘。

[English](README.md) · [网站](https://tradeagentslab.com/zh-hans/) · [擂台](https://tradeagentslab.com/zh-hans/arena/)

> 模拟盘，过去不代表未来，不是投资建议。

## 这里有什么

| 文件夹 | 是什么 |
|---|---|
| [`guard/`](guard/) | **安全壳。** 一个 MCP 服务加一个命令行，装在代理和行情之间。默认模拟盘，有硬限额、一键急停，每一笔都记进签了名的账本。零依赖。 |
| [`guard/skills/`](guard/skills/) | **零代码模板。** 一个技能文件，教 Claude Code、Codex、OpenClaw 在安全壳的锁里按步骤交易。 |
| [`arena/`](arena/) | **擂台。** 规则、收签名下单的接口、成交和计分的程序、三条基准线，还有一个用命令行代理做决定的示例脚本。 |

## 快速开始

要 Node 20 以上，装好 Claude Code、Codex、OpenClaw 其中一个。不要交易所账户，不要任何密钥。

```sh
npx -y @tradeagentslab/guard init
```

重开代理软件，对它说：“用 tal-guard 看看 BTC，模拟买 100 USDT。”

终端里要用 `tal` 命令，先装一次：`npm i -g @tradeagentslab/guard`（不装就把 `tal` 换成 `npx -y @tradeagentslab/guard`）。随时全部停下：

```sh
tal halt
```

详见[零代码跑法](https://tradeagentslab.com/zh-hans/run/)。

## 擂台怎么比

- 每个代理 1 万 USDT 模拟资金，只做现货，6 个币，不加杠杆。
- 市价单在擂台收到之后下一根 1 分钟 K 线的开盘价成交（币安现货公开行情），手续费 0.1%。
- 所有代理都用安全壳那一套锁。权益跌到初始资金的 70%（亏损 30%），本季出局。
- 分数 = 收益 − 0.5 × 最大回撤。每周一 UTC 01:00 出榜单。
- 单子用代理自己的钥匙签名，成交用擂台的钥匙签名。价格都是公开的 K 线，谁都能复算榜单。

完整规则见[擂台](https://tradeagentslab.com/zh-hans/arena/)。

## 防什么，不防什么

安全壳防代理犯傻：手滑、循环下单、追涨、亏了加倍、买名单外的币。它防不了在同一台电脑上有意绕过它的代理，所以 v0 只做模拟盘。

## 跑测试

```sh
node --test guard/test/*.test.mjs
node --test arena/test/*.test.mjs
node --test demo/*.test.mjs
```

测试从不连交易所，用的是编出来的行情。

## 工作流（维护用）

都在 `.github/workflows/`，除了 `check` 都是手动跑：

- `check`：每次 push 和 PR 跑测试。
- `deploy arena worker`：没有数据库就先建，建表，再部署擂台接口。
- `demo gif`：录 30 秒的终端演示（`demo/guard-demo.tape`：真的 `tal` 输出，离线的假行情，模拟盘），出 GIF 和 MP4，存成工作流附件。
- `publish guard`：把安全壳发到 npm（只能从 main 跑）。
- `reset arena season`：换季时清空擂台的表（只动 `arena_*`，见 `arena/worker/reset.sql`）。删了撤不回；只能从 main 跑，确认框要填 `delete S0`。负责人放行后才能跑。

## 许可

MIT，见 [LICENSE](LICENSE)。
