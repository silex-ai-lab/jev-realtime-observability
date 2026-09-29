// POST /v1/preflight (CONTRACTS §9.4; RFC §3.1 control path, §6.5, §7, §7.1). Synchronous: the event
// is stored without a queued job, decided within the budget, and a ControlDecision bound to exactly
// this call is issued. The gateway re-verifies it (sandbox/control.ts); nothing here executes anything.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../storage/db.ts';
import * as repos from '../storage/repos.ts';
import type { JudgeClient } from '../judges/index.ts';
import { evaluateRules } from '../rules/index.ts';
import { assembleSnapshot, RUBRIC } from '../state/index.ts';
import { decide, type PolicyBody } from '../policy/index.ts';
import { redactEvent, eventContentDigest } from '../ingest/index.ts';
import { PreflightRequest, GATE_BUDGET, type PreflightResponse } from '../../contracts/preflight.ts';
import { judgeSourceOf, type EvaluationRecord } from '../../contracts/judge.ts';
import type { StoredEvent } from '../../contracts/events.ts';
import type { ControlDecision, PolicyDecision } from '../../contracts/decision.ts';
import { digestOf } from '../../contracts/canonical.ts';
import type { AuthorityReader } from '../../sandbox/index.ts';
import { authorityVersion } from '../../sandbox/control.ts';

export interface PreflightDeps {
  db: Db;
  judge: JudgeClient | null;          // the gate's judge (AppOptions.gateJudge, else the main judge)
  authority: AuthorityReader;
  policy: (tenantId: string) => Promise<PolicyBody>;
}

export class PreflightError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const ACTION: Record<string, ControlDecision['action']> = {
  NO_CONFIGURED_RISK: 'allow', ALERT: 'allow', REVIEW: 'hold_for_review', UNKNOWN: 'hold_for_review',
  BLOCK: 'deny', STOP: 'deny', REJECT: 'deny',
};
function actionFor(d: PolicyDecision): ControlDecision['action'] {
  if (d.recommended === 'HOLD') return d.decided_by === 'rule' ? 'hold_for_approval' : 'hold_for_review';
  return ACTION[d.recommended] ?? 'deny';     // unknown → fail closed
}

export async function preflight(d: PreflightDeps, tenantId: string, body: unknown): Promise<PreflightResponse> {
  const t0 = performance.now();
  const parsed = PreflightRequest.safeParse(body);
  if (!parsed.success) throw new PreflightError(400, parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  const r = parsed.data;
  // The digest in the request must describe these exact args; the control is bound to it.
  if (digestOf(r.operation.args) !== r.operation.args_digest) throw new PreflightError(400, 'args_digest does not match args');
  const policy = await d.policy(tenantId);
  const now = new Date();

  const ev: StoredEvent = {
    ...redactEvent({ schema_version: r.schema_version, event_id: r.event_id, source_event_id: r.event_id, run_id: r.run_id, trace_id: r.trace_id,
      producer_id: r.producer_id, producer_seq: r.producer_seq, boundary: 'pre_tool', occurred_at: now.toISOString(), actor: r.actor,
      operation: r.operation, sources: r.sources, attributes: { path: 'preflight' } }),
    tenant_id: tenantId, received_at: now.toISOString(), ingest_path: 'sdk',
  };
  const inserted = await d.db.tx(async q => {
    const s = await repos.insertEventWithJob(q, ev, eventContentDigest(ev), null);   // no job: decided here, synchronously
    if (s === 'inserted') await repos.appendOutbox(q, { tenant_id: tenantId, kind: 'event', ref_id: ev.event_id, run_id: ev.run_id,
      payload: { event_id: ev.event_id, run_id: ev.run_id, boundary: 'pre_tool', tool: r.operation.tool, operation_id: r.operation.operation_id,
        producer_id: ev.producer_id, producer_seq: ev.producer_seq, received_at: ev.received_at, ingest_path: 'sdk', actor: ev.actor, attributes: ev.attributes } });
    return s;
  });
  if (inserted !== 'inserted') throw new PreflightError(409, `event ${r.event_id} already recorded (${inserted}); a preflight is never re-issued for the same event`);

  const history = await repos.listRunEvents(d.db, tenantId, r.run_id, ev.received_at, 500);
  const a = await assembleSnapshot({ tenantId, event: ev, history, authority: d.authority, judgeViewMaxTokens: policy.judge_view_max_tokens,
    judgeModel: d.judge?.config.model ?? 'none', now });
  const rules = evaluateRules(a.snapshot);
  const hardDecided = rules.some(x => x.verdict === 'STOP' || x.verdict === 'BLOCK' || x.verdict === 'HOLD');

  let evaluation: EvaluationRecord | null = null;
  const elapsed = performance.now() - t0;
  const judgeBudget = Math.max(0, Math.min(GATE_BUDGET.judgeMaxMs, GATE_BUDGET.totalMs - elapsed - GATE_BUDGET.commitMarginMs));
  const evaluationId = `eval-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  if (!hardDecided && a.judgeRequest) {
    const served = d.judge?.served() ?? null;
    const base = { evaluation_id: evaluationId, tenant_id: tenantId, event_id: ev.event_id, snapshot_id: a.snapshot.snapshot_id, kind: 'realtime' as const,
      rubric_id: RUBRIC.rubric_id, question_ids: a.questionIds, required_question_ids: a.requiredQuestionIds, started_at: startedAt };
    if (!d.judge || judgeBudget < 20) {
      evaluation = { ...base, judge_source: served ? judgeSourceOf(served) : null, served_model: served, request_hash: '', client_request_id: `none-${evaluationId}`,
        vendor_request_id: null, status: d.judge ? 'timeout' : 'not_configured', http_status: null, attempts: 0, judge_http_rtt_ms: null, vendor_latency_ms: null,
        usage: null, billing: 'none', signals: {}, errors: [d.judge ? `no judge budget left (${judgeBudget.toFixed(0)} ms)` : 'no gate judge configured'], finished_at: new Date().toISOString() };
    } else {
      const res = await d.judge.call(a.judgeRequest, a.requiredQuestionIds, { tenantId, evaluationId, caller: 'preflight', deadlineMs: judgeBudget, retry429: false });
      evaluation = { ...base, judge_source: res.served_model ? judgeSourceOf(res.served_model) : (served ? judgeSourceOf(served) : null), served_model: res.served_model ?? served,
        request_hash: res.request_hash, client_request_id: res.client_request_id, vendor_request_id: res.vendor_request_id, status: res.status, http_status: res.http_status,
        attempts: res.attempts, judge_http_rtt_ms: res.judge_http_rtt_ms, vendor_latency_ms: res.vendor_latency_ms, usage: res.usage, billing: res.billing,
        signals: res.signals, errors: res.errors, finished_at: new Date().toISOString() };
    }
  }
  const decision = decide({ snapshot: a.snapshot, rules, evaluation, policy,
    provenance: { source_mode: 'live_sandbox_gate', judge_source: evaluation?.judge_source ?? null, tool_environment: 'sandbox', enforcement_mode: 'gate' },
    decisionId: `dec-${randomUUID()}`, now: new Date().toISOString(),
    timings: { ingest_to_signal_ms: null, snapshot_ms: null, rules_ms: null, judge_http_rtt_ms: evaluation?.judge_http_rtt_ms ?? null, policy_ms: null } });
  const action = actionFor(decision);
  decision.enforced_action = action;           // gate: the action is enforced by the gateway, not merely advised
  decision.would_have = null;

  const issued = new Date();
  const control: ControlDecision = {
    control_id: `ctl-${randomUUID()}`, tenant_id: tenantId, run_id: r.run_id, actor_id: r.actor.id, tool: r.operation.tool,
    operation_id: r.operation.operation_id, args_digest: r.operation.args_digest, policy_version: policy.policy_version,
    snapshot_id: a.snapshot.snapshot_id, authorization_version: await authorityVersion(d.db, tenantId, { tool: r.operation.tool, args: r.operation.args }),
    action, issued_at: issued.toISOString(), expires_at: new Date(issued.getTime() + GATE_BUDGET.controlTtlMs).toISOString(),
    nonce: randomBytes(24).toString('hex'),
  };
  const totalBeforeCommit = performance.now() - t0;
  decision.timings.ingest_to_signal_ms = totalBeforeCommit;
  await d.db.tx(async q => {
    await repos.insertSnapshot(q, a.snapshot);
    if (evaluation) await repos.insertEvaluation(q, evaluation);
    await repos.insertDecision(q, decision, null);
    await q.query(`INSERT INTO control_decisions (tenant_id, control_id, operation_id, nonce, body) VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, control.control_id, control.operation_id, control.nonce, JSON.stringify(control)]);
    if (evaluation) await repos.appendOutbox(q, { tenant_id: tenantId, kind: 'evaluation', ref_id: evaluation.evaluation_id, run_id: r.run_id,
      payload: { evaluation_id: evaluation.evaluation_id, event_id: ev.event_id, snapshot_id: a.snapshot.snapshot_id, kind: 'realtime', status: evaluation.status,
        judge_source: evaluation.judge_source, question_ids: evaluation.question_ids, required_question_ids: evaluation.required_question_ids, signals: evaluation.signals,
        judge_http_rtt_ms: evaluation.judge_http_rtt_ms, vendor_latency_ms: evaluation.vendor_latency_ms, usage: evaluation.usage, billing: evaluation.billing, errors: evaluation.errors } });
    await repos.appendOutbox(q, { tenant_id: tenantId, kind: 'decision', ref_id: decision.decision_id, run_id: r.run_id,
      payload: { ...decision, run_id: r.run_id, boundary: 'pre_tool', tool: r.operation.tool, control_id: control.control_id, control_action: action } });
  });
  return {
    control,
    decision: { decision_id: decision.decision_id, recommended: decision.recommended, decided_by: decision.decided_by, reasons: decision.reasons },
    timings: { total_ms: performance.now() - t0, judge_http_rtt_ms: evaluation?.judge_http_rtt_ms ?? null, judge_budget_ms: judgeBudget },
  };
}
