#!/bin/sh
# Installs or updates the arena engine on the server. Run as root, from a checkout
# of the repository at the commit to deploy:
#
#   sudo sh arena/engine/install/install.sh            # install or update
#   sudo sh arena/engine/install/install.sh --check    # only show what it would do
#
# It creates a system user, copies the code to /opt/arena/<commit>, points
# /opt/arena/current at it, and (re)starts the service. It never touches other
# services on the machine and puts no exchange keys anywhere: the engine needs none.
set -eu

CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1
SRC=$(cd "$(dirname "$0")/../../.." && pwd)
REV=$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)
DEST=/opt/arena/$REV

say() { printf '%s\n' "$*"; }
run() { if [ "$CHECK" = 1 ]; then say "would run: $*"; else "$@"; fi; }

command -v node >/dev/null || { say "node is missing (need 20 or newer)"; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || { say "node $NODE_MAJOR is too old (need 20 or newer)"; exit 1; }

id arena >/dev/null 2>&1 || run useradd --system --home /var/lib/arena --shell /usr/sbin/nologin arena
run install -d -o arena -g arena -m 700 /var/lib/arena
run install -d -m 755 /etc/arena /opt/arena
run install -d -m 755 "$DEST"
run cp -R "$SRC/guard" "$SRC/arena" "$DEST/"
run ln -sfn "$DEST" /opt/arena/current

[ -f /etc/arena/config.json ] || run cp "$SRC/arena/engine/install/config.example.json" /etc/arena/config.json
# The roster in the repository is the source of truth (public, reviewed), so it is always copied.
run install -m 644 "$SRC/arena/season/roster.json" /etc/arena/roster.json

run install -m 644 "$SRC/arena/engine/install/arena-engine.service" /etc/systemd/system/arena-engine.service
run systemctl daemon-reload
run systemctl enable arena-engine
run systemctl restart arena-engine

if [ "$CHECK" = 0 ]; then
  sleep 3
  systemctl --no-pager --lines=5 status arena-engine || true
  say "engine public key (put it in the Worker's ENGINE_PUBKEY):"
  runuser -u arena -- node /opt/arena/current/arena/engine/main.js pubkey --config /etc/arena/config.json
fi
