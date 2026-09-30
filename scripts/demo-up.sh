#!/usr/bin/env bash
# Starts the demo stack on one Mac with 24 GB of memory or more (docs/USER_MANUAL.md "Run the demo on a 24 GB Mac"):
#   - the Kev-0.8B judge on 127.0.0.1:8010 (jaredpalmer/kev-0.8b; Kev-4B is not needed for the demo);
#   - a watch-only (shadow) console on 127.0.0.1:8790 and a gate console on 127.0.0.1:8791, each with its own data dir;
#   - a local OTLP sink on 127.0.0.1:4318 that the gate console exports its decisions to.
# Everything binds to 127.0.0.1 and runs with login off (AUTH_MODE=none), which is only safe on your own machine.
#   bash scripts/demo-up.sh            reuse existing demo data
#   bash scripts/demo-up.sh --reset    start from freshly seeded sandboxes
# Stop with: bash scripts/demo-down.sh   (add --kev to stop the judge too)
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
KEV_DIR="${KEV_DIR:-$HOME/workplace/Silex/third_party/kev}"
KEV_RUN=jaredpalmer/kev-0.8b
STATE="$REPO/.data/demo"               # .data/ is git-ignored
mkdir -p "$STATE"
say() { printf '%s\n' "$*"; }
die() { printf 'demo-up: %s\n' "$*" >&2; exit 1; }
listening() { lsof -tiTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
serves_kev() { curl -s -m 3 "http://127.0.0.1:$1/v1/models" | grep -q "\"run\": *\"$KEV_RUN\""; }
wait_for() {   # wait_for <seconds> <description> <command…>
  local t="$1" what="$2"; shift 2
  for _ in $(seq 1 "$t"); do "$@" && return 0; sleep 1; done
  die "timed out after ${t}s waiting for $what (logs in $STATE)"
}

# 1. Prerequisites
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>23||(a===23&&b>=6)?0:1)' || die "Node >= 23.6 is required (node -v: $(node -v 2>/dev/null))"
[ -d node_modules ] || die "run 'npm ci' first"
command -v uv >/dev/null || die "uv is required for Kev (https://docs.astral.sh/uv/)"
[ -d "$KEV_DIR" ] || die "Kev checkout not found at $KEV_DIR (set KEV_DIR; see skills/deploy-jev-observability/SKILL.md step 3)"
mem_gb=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 ))
[ "$mem_gb" -ge 16 ] || say "warning: ${mem_gb} GB of memory; the demo stack was measured at about 6 GB peak (runs/mem-2026-09-30/footprint.txt)"

if [ "${1:-}" = "--reset" ]; then
  for p in 8790 8791; do listening "$p" && die "port $p is in use; run 'bash scripts/demo-down.sh' before --reset"; done
  rm -rf .data/demo-shadow .data/demo-gate
  say "reset: removed .data/demo-shadow and .data/demo-gate"
fi

# 2. The judge (Kev-0.8B on 8010). The first start downloads the weights from Hugging Face.
if serves_kev 8010; then
  say "judge: $KEV_RUN already serving on 127.0.0.1:8010"
else
  listening 8010 && die "port 8010 is in use by something that is not $KEV_RUN"
  say "judge: starting $KEV_RUN on 127.0.0.1:8010 (first start downloads the weights; this can take several minutes)"
  KEV_DIR="$KEV_DIR" KEV_RUN="$KEV_RUN" KEV_PORT=8010 nohup npm run kev > "$STATE/kev-8010.log" 2>&1 < /dev/null &
  echo $! > "$STATE/kev.pid"
  wait_for 900 "$KEV_RUN on 8010" serves_kev 8010
  say "judge: ready"
fi

# 3. The local OTLP sink (4318)
if listening 4318; then say "otlp sink: port 4318 already in use, reusing it"
else
  nohup node scripts/otlp-sink.mjs 4318 > "$STATE/otlp-sink.log" 2>&1 < /dev/null &
  echo $! > "$STATE/otlp-sink.pid"
  say "otlp sink: http://127.0.0.1:4318/v1/traces (spans are printed to $STATE/otlp-sink.log)"
fi

# 4. The two consoles
JUDGE="JUDGE_BASE_URL=http://127.0.0.1:8010 JUDGE_EXPECTED_RUN=$KEV_RUN AUTH_MODE=none HOST=127.0.0.1"
start_console() {   # start_console <name> <port> <extra env…>
  local name="$1" port="$2"; shift 2
  if listening "$port"; then say "$name console: port $port already in use, reusing it"; return; fi
  # shellcheck disable=SC2086
  nohup env $JUDGE "$@" PORT="$port" DATA_DIR=".data/demo-$name" npm run server > "$STATE/console-$name.log" 2>&1 < /dev/null &
  echo $! > "$STATE/console-$name.pid"
  wait_for 120 "the $name console on $port" curl -sf -m 2 "http://127.0.0.1:$port/readyz" -o /dev/null
}
start_console shadow 8790 SOURCE_MODE=live_sandbox_shadow
start_console gate 8791 SOURCE_MODE=live_sandbox_gate GATE_JUDGE_BASE_URL=http://127.0.0.1:8010 GATE_JUDGE_EXPECTED_RUN="$KEV_RUN" OTLP_EXPORT_URL=http://127.0.0.1:4318/v1/traces

for p in 8790 8791; do
  r=$(curl -s -m 3 "http://127.0.0.1:$p/readyz"); say "readyz :$p $r"
done
cat <<EOF

Demo is up (logs and pids in .data/demo/):
  Gate console (enforcement):   http://127.0.0.1:8791/
  Watch-only console (signals): http://127.0.0.1:8790/
  Simulated demo page:          http://127.0.0.1:8791/demo/index.html   (no model; everything simulated)
  Exported decision spans:      tail -f .data/demo/otlp-sink.log
Open "Run a scenario" and pick SOC1…SOC5. Stop with: bash scripts/demo-down.sh
EOF
