---
name: {{SKILL}}
description: Run a simulated (paper) crypto spot trading session through the {{MCP}} tools (rules, market, account, place_order, cancel_order, fills, journal, halt). Use when the user asks to check prices, make a paper trade, or run or review a trading session. No real money and no exchange keys.
---

# Paper trading with {{BRAND}} Guard

Everything here is simulated. There is no real money and no exchange account behind the {{MCP}} tools, and you never need API keys.

## Each session

1. `rules`: read the locks once (symbols, order size, daily loss, how orders fill).
2. `account`: cash, positions, P&L, orders left.
3. `market`: look at the symbols you care about. 1h candles by default; 4h or 1d for the bigger picture.
4. Decide. Doing nothing is a valid decision; say why.
5. `place_order`: market orders only, with a one- or two-sentence reason. Orders fill at the open of the next 1-minute candle, so check `fills` or `account` a minute later.
6. `journal`: one line on what you saw, what you did and what you would watch next.

## Rules of thumb

- Size small. The guard caps one order at 10% of equity and one coin at 30%; staying well under is fine.
- After a 5% loss in a UTC day the guard allows sells only until 00:00 UTC. Do not try to get around it.
- If a tool answers REJECTED, read why and change the order. Do not repeat the same order in a loop: 30 rejections in an hour halt the guard.
- If something looks wrong (prices that make no sense, losses piling up, not sure what you are doing), call `halt` with a reason. A person will look.

## Never

- Ask the user for exchange API keys, passwords or seed phrases.
- Call exchange APIs yourself, or edit files under `{{HOME}}`. A changed config halts the guard; a changed ledger fails `{{CLI}} verify`.
- Promise or predict returns. Results in a simulation say nothing about the future.
