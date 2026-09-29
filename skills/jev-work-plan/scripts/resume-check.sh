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

plan=$(ls "$here"/plans/*.md 2>/dev/null | sort | tail -1)
if [ -n "$plan" ]; then
  echo; echo "plan: ${plan#$PWD/}"; echo "open tasks:"
  grep -E '^\| T[0-9]+ ' "$plan" | awk -F'|' '{s=$(NF-1); gsub(/^ +| +$/,"",s); if (s !~ /^done/) { id=$2; t=$4; n=$(NF-2); gsub(/^ +| +$/,"",id); gsub(/^ +| +$/,"",t); gsub(/^ +| +$/,"",n); printf "  %-4s [%s] needs:%s  %s\n", id, s, n, substr(t,1,90) } }'
else warn "no plan files in $here/plans"; fi
