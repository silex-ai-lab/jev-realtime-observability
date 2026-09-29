#!/usr/bin/env bash
# Bounded LoRA fine-tune of a released Kev checkpoint on the open-data train split (plan §5 Gate B, §6).
# Time box: 3 h wall clock (FT_TIMEOUT). A timeout is a result, reported as "not completed locally".
# Usage: eval/finetune/finetune.sh 0.8b   (or 4b; 4b only if the 0.8b run finished inside its box)
set -uo pipefail
SIZE="${1:-0.8b}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
KEV_DIR="${KEV_DIR:-$HOME/workplace/Silex/third_party/kev}"
DATA="$REPO/eval/splits/kev-train.jsonl"
OUT="$REPO/runs/ft-kev-$SIZE-$(date +%Y-%m-%d)"
FT_TIMEOUT="${FT_TIMEOUT:-3h}"
case "$SIZE" in
  0.8b) BASE=Qwen/Qwen3.5-0.8B-Base; INIT=jaredpalmer/kev-0.8b ;;
  4b)   BASE=Qwen/Qwen3.5-4B-Base;   INIT=jaredpalmer/kev-4b ;;
  *) echo "size must be 0.8b or 4b"; exit 2 ;;
esac
mkdir -p "$OUT"
{
  echo "started_at=$(date -u +%FT%TZ)"; echo "kev_commit=$(git -C "$KEV_DIR" rev-parse HEAD)"
  echo "data=eval/splits/kev-train.jsonl sha256=$(shasum -a 256 "$DATA" | cut -d' ' -f1) records=$(wc -l < "$DATA")"
  echo "base=$BASE init_from=$INIT timeout=$FT_TIMEOUT device=mps args=--epochs 2 --lr 2e-5 --batch 1 --accum 8 --seed 20260928"
  echo "host=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m) memory_gb=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 ))"
} > "$OUT/RUN.txt"
# GNU `timeout` is not on every Mac: fall back to coreutils' `gtimeout`, then to a perl alarm whose
# SIGALRM exit (142) is mapped to timeout's 124, so a time-out is still reported as not completed.
to_seconds() { case "$1" in *h) echo $(( ${1%h} * 3600 ));; *m) echo $(( ${1%m} * 60 ));; *s) echo "${1%s}";; *) echo "$1";; esac; }
run_boxed() {
  if command -v timeout >/dev/null; then timeout "$FT_TIMEOUT" "$@"
  elif command -v gtimeout >/dev/null; then gtimeout "$FT_TIMEOUT" "$@"
  else perl -e '$SIG{ALRM} = sub { local $SIG{TERM} = "IGNORE"; kill "TERM", -$$; waitpid(-1, 0); exit 124 }; setpgrp(0, 0); alarm shift; my $p = fork // die; if (!$p) { exec @ARGV or die } waitpid($p, 0); exit($? >> 8)' "$(to_seconds "$FT_TIMEOUT")" "$@"
  fi
}
cd "$KEV_DIR"
START=$(date +%s)
run_boxed uv run python -m kev.train --data "$DATA" --base "$BASE" --init_from "$INIT" \
  --epochs 2 --lr 2e-5 --batch 1 --accum 8 --device mps --seed 20260928 --out "$OUT/model" > "$OUT/train.log" 2>&1
CODE=$?
{
  echo "finished_at=$(date -u +%FT%TZ) wall_s=$(( $(date +%s) - START )) exit=$CODE"
  echo "records_used=$(LC_ALL=C tr '\r' '\n' < "$OUT/train.log" | grep -ao '[0-9]* training requests' | grep -o '^[0-9]*') records_dropped=$(LC_ALL=C tr '\r' '\n' < "$OUT/train.log" | grep -ao 'dropped [0-9]*' | grep -o '[0-9]*$')"
  if [ $CODE -eq 124 ]; then echo "result=not_completed_locally (time box $FT_TIMEOUT reached)"; elif [ $CODE -eq 0 ]; then echo "result=completed"; else echo "result=failed (see train.log)"; fi
} >> "$OUT/RUN.txt"
cat "$OUT/RUN.txt"
