# The guard demo: about 30 seconds, rendered by the "demo gif" workflow
# (.github/workflows/demo-gif.yml). Run from the repository root:  vhs demo/guard-demo.tape
#
# Everything on screen is real output of the code in this repository:
# - `tal` is guard/bin/tal.js, installed from this checkout;
# - `agent` is demo/agent.mjs, a script standing in for an AI agent: it starts
#   `tal serve` (the guard's MCP server) and calls one tool, as an agent app does;
# - TAL_OFFLINE=1 makes the guard use its built-in made-up prices, so nothing in this
#   recording talks to an exchange. Paper trading only, no keys anywhere.
# The workflow expects a home folder /home/you with Claude Code and the guard installed
# under /home/you/.local, so `tal init` has an agent app to register with.

Output demo/out/guard-demo.gif
Output demo/out/guard-demo.mp4
Output demo/out/guard-demo.txt

Require node

Set Shell "bash"
Set FontFamily "IBM Plex Mono"
Set FontSize 22
Set LineHeight 1.2
Set Width 1280
Set Height 720
Set Padding 32
Set Framerate 15
Set TypingSpeed 25ms
Set CursorBlink false
Set Theme { "name": "tal", "background": "#0B1220", "foreground": "#DCE4F2", "cursor": "#5B8DEF", "selection": "#1F2C46", "black": "#0B1220", "red": "#EF7F7F", "green": "#4FC48F", "yellow": "#E3A76A", "blue": "#5B8DEF", "magenta": "#C38FEA", "cyan": "#3EC2B0", "white": "#DCE4F2", "brightBlack": "#5D6A84", "brightRed": "#EF7F7F", "brightGreen": "#4FC48F", "brightYellow": "#E3A76A", "brightBlue": "#5B8DEF", "brightMagenta": "#C38FEA", "brightCyan": "#3EC2B0", "brightWhite": "#FFFFFF" }

Hide
Type `DEMO="$PWD/demo"; alias agent="node $DEMO/agent.mjs"`
Enter
Type `export HOME=/home/you PATH=/home/you/.local/bin:$PATH LANG=C.UTF-8 TAL_OFFLINE=1 PS1='$ '`
Enter
Type "cd ~ && clear"
Enter
Sleep 500ms
Show

# 1. Install: paper trading, a local signing key, registered with the agent app.
Type "tal init"
Sleep 300ms
Enter
Sleep 5s

Hide
Type "clear"
Enter
Sleep 200ms
Show

# 2. The account.
Type "tal status"
Sleep 300ms
Enter
Sleep 2s
Enter
Sleep 800ms

# 3. Orders, the way an agent sends them (MCP tool calls).
Type `# "agent" is a script: it calls the guard's MCP tools, like an AI agent would.`
Enter
Sleep 400ms
Type `agent place_order symbol=BTC side=buy usdt=500 reason="Small first position."`
Sleep 300ms
Enter
Sleep 3s

# 4. Over 10% of equity in one order.
Type `agent place_order symbol=ETH side=buy usdt=2500 reason="All in on ETH."`
Sleep 300ms
Enter
Sleep 3s

# 5. A coin that is not on the list.
Type `agent place_order symbol=PEPE side=buy usdt=200 reason="Trending coin."`
Sleep 300ms
Enter
Sleep 3s

Hide
Type "clear"
Enter
Sleep 200ms
Show

# 6. The kill switch, then any order is refused.
Type "# Kill switch. After this, no order gets through until a person runs: tal resume"
Enter
Sleep 400ms
Type `tal halt --reason "Stop for today."`
Sleep 300ms
Enter
Sleep 1500ms
Type `agent place_order symbol=BTC side=buy usdt=100 reason="Buy the dip."`
Sleep 300ms
Enter
Sleep 3s

# 7. End frame.
Hide
Type `clear && cat "$DEMO/end.txt"`
Enter
Sleep 300ms
Show
Sleep 5s
