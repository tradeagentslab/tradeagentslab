#!/bin/sh
# Installs or updates the arena engine on the server. Run as root, from a copy of
# the repository at the commit to deploy (the server has no .git, so say which
# commit it is):
#
#   sudo sh arena/engine/install/install.sh --rev <commit>            # install or update
#   sudo sh arena/engine/install/install.sh --rev <commit> --check    # only show what it would do
#   sudo REV=<commit> sh arena/engine/install/install.sh               # same, commit from the environment
#
# Node: /opt/node20/bin/node (the operator's Node 20); override with NODE=/path/to/node.
#
# It creates a system user, adds it to the operator's binguard group, copies the
# code to /opt/arena/<commit>, points /opt/arena/current at it, and (re)starts the
# service. It never touches other services or the shared pause directory, and puts
# no exchange keys anywhere: the engine needs none.
#
# Expected from the operator's own installer first (this script never creates them):
#   - group binguard
#   - /var/lib/binance-guard, owner root, group binguard, mode 1775 (sticky)
# The engine creates /var/lib/binance-guard/arena.pause itself the first time it
# has to write it (temp file in that directory, then rename).
set -eu

CHECK=0
REV=${REV:-}
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --rev) [ $# -ge 2 ] || { echo "--rev needs a commit id"; exit 1; }; REV=$2; shift ;;
    --rev=*) REV=${1#--rev=} ;;
    *) echo "unknown argument: $1"; exit 1 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
run() { if [ "$CHECK" = 1 ]; then say "would run: $*"; else "$@"; fi; }

[ -n "$REV" ] || { say "say which commit this is: --rev <commit> (or REV=<commit>)"; exit 1; }
printf '%s' "$REV" | grep -Eq '^[0-9a-f]{7,40}$' || { say "--rev must be a commit id (7 to 40 hex characters), got: $REV"; exit 1; }

SRC=$(cd "$(dirname "$0")/../../.." && pwd)
DEST=/opt/arena/$REV
NODE=${NODE:-/opt/node20/bin/node}
PAUSE_DIR=/var/lib/binance-guard
PAUSE_GROUP=binguard

[ -x "$NODE" ] || { say "node not found at $NODE (need 20 or newer; set NODE=... to use another path)"; exit 1; }
NODE_MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || { say "node $NODE_MAJOR at $NODE is too old (need 20 or newer)"; exit 1; }
[ "$NODE" = /opt/node20/bin/node ] || say "note: the service file runs /opt/node20/bin/node, not $NODE"
getent group "$PAUSE_GROUP" >/dev/null 2>&1 || { say "group $PAUSE_GROUP is missing: run the operator's binance-guard installer first (this script does not create it)"; exit 1; }
[ -d "$PAUSE_DIR" ] || { say "$PAUSE_DIR is missing: run the operator's binance-guard installer first (this script does not create it)"; exit 1; }

id arena >/dev/null 2>&1 || run useradd --system --home /var/lib/arena --shell /usr/sbin/nologin arena
# Group write on the sticky pause directory lets the engine write (only) its own arena.pause.
run usermod -aG "$PAUSE_GROUP" arena
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
  runuser -u arena -- "$NODE" /opt/arena/current/arena/engine/main.js pubkey --config /etc/arena/config.json
fi
