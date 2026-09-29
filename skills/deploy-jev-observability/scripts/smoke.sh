#!/usr/bin/env bash
# Post-deployment smoke test. Reads keys and port from ./.env (or the environment).
# Uses only the public API; runs sandbox scenarios S3 and S1 (sandbox data only).
set -u
[ -f .env ] && { set -a; . ./.env; set +a; }
BASE="${SMOKE_BASE:-http://${HOST:-127.0.0.1}:${PORT:-8787}}"
EXPECT_RUN="${JUDGE_EXPECTED_RUN:-}"
die() { echo "SMOKE FAIL: $*"; exit 1; }
j() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
# Authentication is optional (AUTH_MODE). Keys are only needed when the server says mode=keys.
MODE=$(curl -sf -m 5 "$BASE/v1/auth" | j 'd["mode"]') || die "/v1/auth unreachable at $BASE"
if [ "$MODE" = keys ]; then
  : "${READER_KEY:?READER_KEY not set (server runs AUTH_MODE=keys)}" "${ADMIN_KEY:?ADMIN_KEY not set (server runs AUTH_MODE=keys)}"
  RH=(-H "authorization: Bearer $READER_KEY"); AH=(-H "authorization: Bearer $ADMIN_KEY")
else RH=(); AH=(); fi
echo "ok  auth mode: $MODE"
get() { curl -sf -m 15 ${RH[@]+"${RH[@]}"} "$BASE$1"; }

curl -sf -m 5 "$BASE/healthz" >/dev/null || die "/healthz unreachable at $BASE"; echo "ok  /healthz"
rz=$(curl -s -m 15 "$BASE/readyz") || die "/readyz unreachable"
[ "$(echo "$rz" | j 'd["db"]')" = ok ] || die "/readyz db: $rz"
jr=$(echo "$rz" | j 'd["judge"]'); [ "$jr" = ok ] || die "/readyz judge: $jr (start Kev, check JUDGE_BASE_URL)"; echo "ok  /readyz db=ok judge=ok"
src=$(get /v1/judge | j 'd["judge_source"]') || die "/v1/judge failed"
[ -z "$EXPECT_RUN" ] || echo "$src" | grep -q "$EXPECT_RUN" || die "judge_source $src does not match JUDGE_EXPECTED_RUN=$EXPECT_RUN"
echo "ok  judge_source=$src"

run_scn() {
  local sc=$1 rid
  rid=$(curl -sf -m 15 -X POST ${AH[@]+"${AH[@]}"} -H 'content-type: application/json' -d "{\"scenario\":\"$sc\"}" "$BASE/v1/sandbox/runs" | j 'd["run_id"]') || die "could not start $sc"
  for _ in $(seq 1 60); do
    out=$(get "/v1/runs/$rid" 2>/dev/null) && echo "$out" | python3 -c '
import sys,json; d=json.load(sys.stdin); t=d["timeline"]
pre=[x for x in t if x["event"]["boundary"]=="pre_tool"]
sys.exit(0 if pre and all(x["decisions"] for x in pre) and any(x["event"]["boundary"]=="run_finished" for x in t) else 1)' && { echo "$out"; return 0; }
    sleep 1
  done
  die "$sc did not finish with decisions for every pre_tool in 60 s"
}

s3=$(run_scn S3)
echo "$s3" | python3 -c '
import sys,json; t=json.load(sys.stdin)["timeline"]
d=[x["decisions"][0] for x in t if x["event"]["boundary"]=="pre_tool" and x["event"]["operation"]["tool"]=="payments.execute"][0]
assert d["recommended"]=="BLOCK" and d["decided_by"]=="rule" and any(r["rule_id"]=="amount_limit" and r["verdict"]=="BLOCK" for r in d["rule_results"]), d["recommended"]' \
  || die "S3 was not blocked by the amount_limit rule"
echo "ok  S3 over-limit payment: BLOCK by amount_limit"

s1=$(run_scn S1)
echo "$s1" | python3 -c '
import sys,json; t=json.load(sys.stdin)["timeline"]
ev=[e for x in t for e in x.get("evaluations",[]) if e["kind"]=="realtime" and e["question_ids"]]
assert ev, "no judge evaluations"
bad=[e["status"] for e in ev if e["status"]!="ok"]
assert not bad, bad
assert all((e["judge_source"] or "").startswith(("kev-local:","typesafe:")) for e in ev)' \
  || die "S1 judge evaluations were missing or not ok (check judge latency and WORKER_CONCURRENCY)"
echo "ok  S1 judge evaluations ok from $src"

get /v1/metrics >/dev/null || die "/v1/metrics failed"; echo "ok  /v1/metrics"
echo "SMOKE PASS"
