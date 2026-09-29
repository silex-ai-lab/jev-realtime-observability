#!/usr/bin/env bash
# Pre-deployment host check for jev-realtime-observability. Read-only: installs nothing.
# Prints PASS / WARN / FAIL per check and exits 1 if any FAIL.
set -u
fails=0
pass() { printf 'PASS  %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; fails=$((fails + 1)); }

# Node >= 23.6 (native TypeScript type stripping, no build step)
if command -v node >/dev/null; then
  v=$(node -p 'process.versions.node'); maj=${v%%.*}; min=$(echo "$v" | cut -d. -f2)
  if [ "$maj" -gt 23 ] || { [ "$maj" -eq 23 ] && [ "$min" -ge 6 ]; }; then pass "node $v"; else fail "node $v (need >= 23.6)"; fi
else fail "node not found (need >= 23.6)"; fi

# uv + Python 3.12/3.13 for Kev
if command -v uv >/dev/null; then pass "uv $(uv --version | awk '{print $2}')"; else fail "uv not found (https://docs.astral.sh/uv/)"; fi
if command -v python3.13 >/dev/null || command -v python3.12 >/dev/null || uv python find 3.13 >/dev/null 2>&1; then pass "python 3.12/3.13 available"; else warn "no python 3.12/3.13 found; 'uv sync' will try to download one"; fi

# Accelerator
os=$(uname -s)
if [ "$os" = Darwin ]; then
  chip=$(sysctl -n machdep.cpu.brand_string 2>/dev/null); mem=$(( $(sysctl -n hw.memsize) / 1073741824 ))
  case "$chip" in Apple*) pass "Apple Silicon: $chip, ${mem} GB (MLX)";; *) fail "not Apple Silicon ($chip): Kev's Mac path needs MLX";; esac
  [ "$mem" -lt 32 ] && warn "${mem} GB RAM: use Kev-0.8B (Kev-4B is listed for 32 GB Macs)"
elif command -v nvidia-smi >/dev/null; then
  nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | while read -r l; do pass "GPU: $l"; done
else warn "no NVIDIA GPU or Apple Silicon detected: Kev would run on CPU and be far too slow for realtime"; fi

# Disk (models + caches ~30 GB)
free_gb=$(df -Pk "${HOME}" | awk 'NR==2{print int($4/1048576)}')
if [ "$free_gb" -ge 30 ]; then pass "disk: ${free_gb} GB free in \$HOME"; else warn "disk: only ${free_gb} GB free in \$HOME (models and caches need about 30 GB)"; fi

# Ports
for p in 8009 8787; do
  if (command -v lsof >/dev/null && lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1); then warn "port $p already in use"; else pass "port $p free"; fi
done

# Network (skip if offline install is planned)
code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' https://registry.npmjs.org/zod || true)
[ "$code" = 200 ] && pass "npmjs registry reachable" || warn "npmjs registry not reachable (HTTP $code): npm ci will fail without a mirror"
code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' https://huggingface.co/api/models/jaredpalmer/kev-4b || true)
[ "$code" = 200 ] && pass "huggingface.co reachable" || warn "huggingface.co not reachable (HTTP $code): copy the HF cache and set HF_HUB_OFFLINE=1"

echo
[ "$fails" -eq 0 ] && echo "HOST CHECK: no FAIL" || echo "HOST CHECK: $fails FAIL"
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
