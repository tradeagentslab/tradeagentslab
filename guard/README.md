# TradeAgents Lab Guard

A safety shell between AI agents and the market: paper trading by default, hard limits, a kill switch and a signed ledger. Zero dependencies.

> Simulated trading. Past results don't predict future results. Not investment advice. Not for residents of the UK or US.

## Install

Node 20 or newer, plus Claude Code, Codex or OpenClaw.

```sh
npx -y @tradeagentslab/guard init
```

This registers the guard with the agent apps it finds (using `claude mcp add`, `codex mcp add` and `openclaw mcp set`), installs the no-code template, writes a paper-trading config and creates a signing key that never leaves your computer. Add `--dry-run` to see the steps first.

## What the agent can do

Eight tools, nothing more: `market`, `account`, `place_order` (market orders, a reason is required), `cancel_order`, `fills`, `rules`, `halt`, `journal`.

There is no tool for withdrawals, transfers, leverage, futures, changing limits or lifting a halt.

## The locks

| Lock | Default |
|---|---|
| Symbols | BTC, ETH, SOL, BNB, XRP, DOGE against USDT, spot only |
| One order | 10 USDT to 10% of equity |
| One coin | At most 30% of equity |
| One day | After a 5% loss since 00:00 UTC, sells only |
| Total loss | Equity at 70% of the start (a 30% loss) halts trading |
| Pace | 12 orders an hour, 60 a day |
| Loops | 30 refused orders in an hour halts trading |
| Stale prices | No trading on prices older than 2 minutes |

Orders fill at the open of the next 1-minute candle (Binance spot public data; OKX if Binance can't be reached) with a 0.1% fee. All money is counted in exact 8-decimal integers.

## For people

Install the command once with `npm i -g @tradeagentslab/guard`, or write `npx -y @tradeagentslab/guard` instead of `tal`.

```sh
tal status            # account, positions, today's P&L
tal halt [--flatten]  # stop now; --flatten also sells everything
tal resume            # lift a halt (asks you to type yes)
tal limits            # show the locks
tal limits set max_order_pct=5   # change them (asks you to type yes)
tal verify            # check the ledger's chain and signatures
tal replay            # the day's ledger, line by line
tal uninstall         # remove it from your agent apps; your ledger stays
```

## The ledger

Every order, fill, refusal, halt and journal line is appended to `~/.tal/ledger/<agent>/<date>.jsonl`. Each line is canonical JSON with the SHA-256 of the line before it and an Ed25519 signature. `state/<agent>.json` is only a cache; delete it and the guard rebuilds the account from the ledger.

## Limits of the design

It protects against an agent making mistakes. It can't stop an agent that sets out to get around it on the same computer: that agent has your permissions. That's why version 0 has no real-trading path at all.

## Tests

```sh
node --test test/*.test.mjs
```

No network: the tests use made-up market data. `TAL_OFFLINE=1` runs the whole guard on a made-up market too, for demos.

## Source

https://github.com/tradeagentslab/tradeagentslab

## License

MIT
