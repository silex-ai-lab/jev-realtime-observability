// GET /v1/metrics (CONTRACTS §8.5, RFC §11.1). Computed from stored records only; every ratio
// carries its numerator and denominator so nothing reads as a bare percentage.
import type { Queryable } from '../storage/db.ts';
import { ALL_GATED_TOOLS } from '../../sandbox/control.ts';
import type { EvaluationRecord } from '../../contracts/judge.ts';
import type { PolicyDecision } from '../../contracts/decision.ts';

const nearestRank = (xs: number[], q: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(q * s.length) - 1)];
};
const ratio = (num: number, den: number) => ({ numerator: num, denominator: den, value: den ? num / den : null });

export async function computeMetrics(q: Queryable, tenantId: string, runId: string | null) {
  const runFilter = runId ? ' AND run_id = $2' : '';
  const params = runId ? [tenantId, runId] : [tenantId];

  // Capture coverage: attempted tool calls (gateway) that also produced a captured pre_tool event.
  const attempts = await q.query<{ operation_id: string }>(`SELECT operation_id FROM gateway_attempts WHERE tenant_id = $1${runFilter}`, params);
  const captured = await q.query<{ operation_id: string }>(
    `SELECT DISTINCT body->'operation'->>'operation_id' AS operation_id FROM events WHERE tenant_id = $1${runFilter} AND boundary = 'pre_tool'`, params);
  const capturedSet = new Set(captured.rows.map(r => r.operation_id));
  const capturedAttempts = attempts.rows.filter(r => capturedSet.has(r.operation_id)).length;

  const evals = (await q.query<{ body: EvaluationRecord }>(
    `SELECT e.body FROM evaluations e JOIN events v ON v.tenant_id = e.tenant_id AND v.event_id = e.event_id WHERE e.tenant_id = $1${runId ? ' AND v.run_id = $2' : ''} AND e.kind = 'realtime'`, params)).rows.map(r => r.body);
  const asked = evals.filter(e => e.question_ids.length > 0);
  const covered = asked.filter(e => e.status === 'ok' || (e.status === 'partial' && e.required_question_ids.every(qid => e.signals[qid])));
  const answeredIds = new Set(asked.filter(e => e.status === 'ok' || e.status === 'partial').map(e => e.evaluation_id));

  const decisions = (await q.query<{ body: PolicyDecision }>(
    `SELECT d.body FROM decisions d JOIN events v ON v.tenant_id = d.tenant_id AND v.event_id = d.event_id WHERE d.tenant_id = $1${runId ? ' AND v.run_id = $2' : ''} AND d.replay_of IS NULL`, params)).rows.map(r => r.body);
  const judgePath = decisions.filter(d => d.evaluation_id && answeredIds.has(d.evaluation_id)).map(d => d.timings.ingest_to_signal_ms).filter((v): v is number => v != null);
  const noJudge = decisions.filter(d => d.timings.judge_http_rtt_ms == null).map(d => d.timings.ingest_to_signal_ms).filter((v): v is number => v != null);
  // Judge was called but returned no usable answer (timeout, error, mismatch): its own bucket, never mixed into either path.
  const judgeFailed = decisions.filter(d => d.timings.judge_http_rtt_ms != null && !(d.evaluation_id && answeredIds.has(d.evaluation_id))).map(d => d.timings.ingest_to_signal_ms).filter((v): v is number => v != null);
  const rtt = asked.filter(e => answeredIds.has(e.evaluation_id)).map(e => e.judge_http_rtt_ms).filter((v): v is number => v != null);

  const outcomes = await q.query<{ state: string; n: number }>(`SELECT state, count(*)::int n FROM outcome_checks WHERE tenant_id = $1${runFilter} GROUP BY 1`, params);
  const expired = await q.query<{ n: number }>(
    `SELECT count(*)::int n FROM evaluation_jobs j JOIN events v ON v.tenant_id = j.tenant_id AND v.event_id = j.event_id WHERE j.tenant_id = $1${runId ? ' AND v.run_id = $2' : ''} AND j.status = 'expired'`, params);

  // Gate C (CONTRACTS §9.5). "prevented" is only a not_executed receipt under a non-allow control (RFC §2).
  const gated = await q.query<{ operation_id: string }>(`SELECT operation_id FROM gateway_attempts WHERE tenant_id = $1${runFilter} AND tool = ANY($${params.length + 1})`, [...params, [...ALL_GATED_TOOLS]]);
  const receipts = await q.query<{ operation_id: string; status: string; control_action: string | null }>(
    `SELECT r.operation_id, r.body->>'status' AS status, c.body->>'action' AS control_action
       FROM execution_receipts r LEFT JOIN control_decisions c ON c.tenant_id = r.tenant_id AND c.control_id = r.body->>'control_id'
      WHERE r.tenant_id = $1 AND r.operation_id = ANY($2)`, [tenantId, gated.rows.map(g => g.operation_id)]);
  const withControl = receipts.rows.filter(x => x.control_action != null);
  const preflightMs = (await q.query<{ ms: string }>(
    `SELECT body->'attributes'->>'sdk_preflight_ms' AS ms FROM events WHERE tenant_id = $1${runFilter} AND boundary = 'post_tool' AND body->'attributes' ? 'sdk_preflight_ms'`, params))
    .rows.map(r => Number(r.ms)).filter(Number.isFinite);

  return {
    scope: runId ? { run_id: runId } : { tenant: 'all runs' },
    gate: {
      gated_attempts: gated.rows.length,
      enforcement_coverage: ratio(new Set(withControl.map(x => x.operation_id)).size, gated.rows.length),
      prevented: withControl.filter(x => x.status === 'not_executed' && x.control_action !== 'allow').length,
      executed_under_allow: withControl.filter(x => x.status === 'executed' && x.control_action === 'allow').length,
      not_executed_under_allow: withControl.filter(x => x.status === 'not_executed' && x.control_action === 'allow').length,
      sdk_preflight_ms: { n: preflightMs.length, p50: nearestRank(preflightMs, 0.5), p95: nearestRank(preflightMs, 0.95) },
    },
    capture_coverage: ratio(capturedAttempts, attempts.rows.length),
    semantic_coverage: ratio(covered.length, asked.length),
    realtime_expired: expired.rows[0]?.n ?? 0,
    ingest_to_signal_ms: {
      judge_path: { n: judgePath.length, p50: nearestRank(judgePath, 0.5), p95: nearestRank(judgePath, 0.95) },
      no_judge_path: { n: noJudge.length, p50: nearestRank(noJudge, 0.5), p95: nearestRank(noJudge, 0.95) },
      judge_failed: { n: judgeFailed.length, p50: nearestRank(judgeFailed, 0.5), p95: nearestRank(judgeFailed, 0.95) },
    },
    judge_http_rtt_ms: { n: rtt.length, p50: nearestRank(rtt, 0.5), p95: nearestRank(rtt, 0.95) },
    outcomes: Object.fromEntries(outcomes.rows.map(r => [r.state, r.n])),
    measured: 'monotonic in-process durations; ingest_to_signal uses one process clock',
  };
}
