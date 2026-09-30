#!/usr/bin/env bash
# Stops what scripts/demo-up.sh started, using only the pids it recorded in .data/demo/ (nothing else is touched).
#   bash scripts/demo-down.sh          stop the two consoles and the OTLP sink; leave the judge running
#   bash scripts/demo-down.sh --kev    also stop the Kev-0.8B judge demo-up started
set -uo pipefail
STATE="$(cd "$(dirname "$0")/.." && pwd)/.data/demo"
stop() {   # stop <name>
  local f="$STATE/$1.pid"
  [ -f "$f" ] || return 0
  local pid; pid=$(cat "$f")
  if kill -0 "$pid" 2>/dev/null; then
    pkill -TERM -P "$pid" 2>/dev/null   # npm run starts a child process
    kill -TERM "$pid" 2>/dev/null
    printf 'stopped %s (pid %s)\n' "$1" "$pid"
  fi
  rm -f "$f"
}
stop console-shadow
stop console-gate
stop otlp-sink
[ "${1:-}" = "--kev" ] && stop kev
exit 0
