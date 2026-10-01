#!/usr/bin/env bash
# Checks this machine before resuming the dated work plan, and lists the open tasks.
# Run from the repo root: bash skills/jev-work-plan/scripts/resume-check.sh
set -u
here="$(cd "$(dirname "$0")/.." && pwd)"
ok()   { echo "ok    $*"; }
warn() { echo "WARN  $*"; }
fail() { echo "FAIL  $*"; }

if v=$(node -p 'process.versions.node' 2>/dev/null); then
  maj=${v%%.*}; rest=${v#*.}; min=${rest%%.*}
  if [ "$maj" -gt 23 ] || { [ "$maj" -eq 23 ] && [ "$min" -ge 6 ]; }; then ok "node $v"; else fail "node $v (need >= 23.6)"; fi
else fail "node not found"; fi

if git rev-parse --git-dir >/dev/null 2>&1; then
  # Renamed 2026-09-30: jev-realtime-observability → jev-runtime-observability. GitHub redirects the old URL,
  # but an old clone should point at the new one.
  NEW_URL=https://github.com/silex-ai-lab/jev-runtime-observability.git
  url=$(git remote get-url origin 2>/dev/null || true)
  case "$url" in
    *jev-realtime-observability*) fail "origin is the old repo name ($url): git remote set-url origin $NEW_URL" ;;
    *jev-runtime-observability*) ok "origin $url" ;;
    "") warn "no origin remote: git remote add origin $NEW_URL" ;;
    *) warn "origin is $url (expected $NEW_URL)" ;;
  esac
  top=$(git rev-parse --show-toplevel)
  [ "$(basename "$top")" = jev-realtime-observability ] && warn "checkout folder still uses the old name ($top); optional: mv it to jev-runtime-observability and re-link the skills below"
  for d in "$HOME/.claude/skills" "$HOME/.codex/skills"; do
    for sk in jev-work-plan deploy-jev-observability; do
      l="$d/$sk"; [ -L "$l" ] || continue
      if [ ! -e "$l" ]; then fail "$l is a broken link ($(readlink "$l")): ln -sfn $top/skills/$sk $l"
      else case "$(readlink "$l")" in *jev-realtime-observability*) warn "$l still points at the old folder name ($(readlink "$l"))" ;; esac; fi
    done
  done
  git fetch -q origin 2>/dev/null || warn "git fetch failed (offline?)"
  br=$(git rev-parse --abbrev-ref HEAD)
  if git rev-parse -q --verify "origin/$br" >/dev/null; then
    behind=$(git rev-list --count "HEAD..origin/$br"); ahead=$(git rev-list --count "origin/$br..HEAD")
    [ "$behind" -eq 0 ] && ok "branch $br is not behind origin" || fail "branch $br is $behind commit(s) behind origin: git pull --ff-only"
    [ "$ahead" -eq 0 ] || warn "branch $br has $ahead unpushed commit(s)"
  else warn "no origin/$br"; fi
  [ -z "$(git status --porcelain)" ] && ok "working tree clean" || warn "uncommitted changes present"
else fail "not in a git repository (run from the repo root)"; fi

[ -d node_modules ] && ok "node_modules present" || fail "node_modules missing: npm ci"
[ -f .env ] && ok ".env present" || warn ".env missing (never in git): cp deploy/env.example .env, then see deploy skill step 4"
for port in 8009 8010; do
  if run=$(curl -s -m 3 "127.0.0.1:$port/v1/models" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).models[0].run)}catch{process.exit(1)}})' 2>/dev/null); then
    ok "kev on :$port serves $run"
  else warn "no kev on :$port (only tasks marked needs: kev require it)"; fi
done

# Kev checkout (needed to serve a judge or to fine-tune). The pin is in docs/THIRD_PARTY.md and scripts/kev-serve.sh.
KEV_DIR="${KEV_DIR:-$HOME/workplace/Silex/third_party/kev}"; pin=3e1cd3b
if [ -d "$KEV_DIR/.git" ]; then
  head=$(git -C "$KEV_DIR" rev-parse --short=7 HEAD 2>/dev/null)
  [ "$head" = "$pin" ] && ok "kev checkout $KEV_DIR at $pin" || warn "kev checkout at $head, pinned $pin: git -C $KEV_DIR checkout $pin"
else warn "no kev checkout at $KEV_DIR (needs: kev/gpu): see deploy skill step 3"; fi

# Hardware bar for 'needs: gpu' (a Kev-4B fine-tune): an H100/L40S, or an Apple Silicon Mac with >= 32 GB.
if [ "$(uname)" = Darwin ]; then
  gb=$(( $(sysctl -n hw.memsize) / 1073741824 )); chip=$(sysctl -n machdep.cpu.brand_string 2>/dev/null)
  [ "$gb" -ge 32 ] && ok "$chip, ${gb} GB: meets 'needs: gpu'" || warn "$chip, ${gb} GB: under the 32 GB 'gpu' bar (ask the user before substituting Kev-0.8B)"
elif command -v nvidia-smi >/dev/null; then ok "GPU: $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -1)"
else warn "no Apple Silicon or NVIDIA GPU detected: 'needs: gpu' tasks cannot run here"; fi
command -v timeout >/dev/null || command -v gtimeout >/dev/null && ok "GNU timeout available" || ok "no GNU timeout: finetune.sh uses eval/finetune/timebox.pl (perl)"

# PostgreSQL for 'needs: pg'. Installing it needs the user's OK.
if [ -n "${TEST_DATABASE_URL:-}" ]; then ok "TEST_DATABASE_URL is set (real-PostgreSQL tests will run)"
elif command -v psql >/dev/null || command -v pg_ctl >/dev/null; then warn "PostgreSQL binaries present, TEST_DATABASE_URL unset (set it to run 'needs: pg' tests)"
elif command -v docker >/dev/null && docker info >/dev/null 2>&1; then warn "no PostgreSQL, Docker running: docker run -d -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:17"
else warn "no PostgreSQL or Docker: 'needs: pg' tasks cannot run here without an install (ask the user)"; fi

plan=$(ls "$here"/plans/*.md 2>/dev/null | sort | tail -1)
if [ -n "$plan" ]; then
  echo; echo "plan: ${plan#$PWD/}"; echo "open tasks:"
  grep -E '^\| [A-Z][0-9]+ ' "$plan" | awk -F'|' '{s=$(NF-1); gsub(/^ +| +$/,"",s); if (s !~ /^done/) { id=$2; t=$4; n=$(NF-2); gsub(/^ +| +$/,"",id); gsub(/^ +| +$/,"",t); gsub(/^ +| +$/,"",n); printf "  %-4s [%s] needs:%s  %s\n", id, s, n, substr(t,1,90) } }'
else warn "no plan files in $here/plans"; fi
