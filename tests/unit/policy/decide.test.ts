// RFC §7 decision order (plan §4). Pure policy tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, validatePolicy, DEFAULT_POLICY, wouldHaveAction } from '../../../server/policy/index.ts';
import type { DecisionSnapshot } from '../../../contracts/snapshot.ts';
import type { EvaluationRecord, Signal } from '../../../contracts/judge.ts';
import type { RuleResult } from '../../../contracts/decision.ts';

const snap = (over: Partial<DecisionSnapshot> = {}): DecisionSnapshot => ({
  snapshot_id: 's1', tenant_id: 't', run_id: 'r', event_id: 'e', boundary: 'pre_tool', as_of: new Date(0).toISOString(), cutoff_seq: 1,
  extractor_version: 'x', task_goal: null, candidate_action: { tool: 'payments.execute', operation_id: 'op', impact: 'payment', args_summary: {} },
  history: [], evidence: [], facts: {}, required_evidence: [], missing_evidence: [], stale_evidence: [],
  judge_view: { state: '', token_estimate: 0, truncated: false }, ...over,
});
const noul = (q: string, p: number): Signal => ({ question_id: q, type: 'noul', raw_probability: p, choice: null, probabilities: null, vendor_confidence: null, score: null, legend: null, margin_local: Math.abs(2 * p - 1), p_calibrated: null, calibration_id: null });
const evaluation = (status: EvaluationRecord['status'], signals: Record<string, Signal>, required: string[]): EvaluationRecord => ({
  evaluation_id: 'ev1', tenant_id: 't', event_id: 'e', snapshot_id: 's1', kind: 'realtime', rubric_id: 'r', question_ids: Object.keys(signals), required_question_ids: required,
  judge_source: 'kev-local:jaredpalmer/kev-4b', served_model: null, request_hash: 'h', client_request_id: 'c', vendor_request_id: null, status, http_status: 200,
  attempts: 1, judge_http_rtt_ms: 10, vendor_latency_ms: 9, usage: null, billing: 'local_compute', signals, errors: [], started_at: '', finished_at: '' });
const rule = (id: string, verdict: RuleResult['verdict']): RuleResult => ({ rule_id: id, verdict, reason: id, evidence_refs: [], authoritative_source: 'sandbox' });
const prov = { source_mode: 'live_sandbox_shadow', judge_source: 'kev-local:x', tool_environment: 'sandbox', enforcement_mode: 'shadow' } as const;
const run = (s: DecisionSnapshot, rules: RuleResult[], ev: EvaluationRecord | null, policy = DEFAULT_POLICY) =>
  decide({ snapshot: s, rules, evaluation: ev, policy, provenance: prov, decisionId: 'd', now: new Date(0).toISOString(),
    timings: { ingest_to_signal_ms: null, snapshot_ms: null, rules_ms: null, judge_http_rtt_ms: null, policy_ms: null } });

test('hard rule decides and no signal can change it', () => {
  const d = run(snap(), [rule('amount_limit', 'BLOCK')], evaluation('ok', { goal_deviation: noul('goal_deviation', 0.01) }, []));
  assert.equal(d.recommended, 'BLOCK'); assert.equal(d.decided_by, 'rule');
  assert.equal(d.would_have, 'deny'); assert.equal(d.enforced_action, null);
});

test('missing evidence holds a payment (evidence gate), before any semantic step', () => {
  const d = run(snap({ missing_evidence: ['authority:account'] }), [rule('amount_limit', 'PASS')], evaluation('ok', {}, []));
  assert.equal(d.recommended, 'HOLD'); assert.equal(d.decided_by, 'evidence_gate');
});

test('judge timeout on a payment is HOLD, never "no configured risk"', () => {
  const d = run(snap(), [rule('amount_limit', 'PASS')], evaluation('timeout', {}, ['goal_deviation']));
  assert.equal(d.recommended, 'HOLD'); assert.equal(d.decided_by, 'judge_unavailable');
  assert.ok(d.coverage_gaps.length > 0);
});

test('judge failure on a read tool continues with an alert', () => {
  const s = snap({ candidate_action: { tool: 'vendor.lookup', operation_id: 'op', impact: 'read', args_summary: {} } });
  const d = run(s, [], evaluation('timeout', {}, []));
  assert.equal(d.recommended, 'ALERT'); assert.equal(d.would_have, 'allow_and_alert');
});

test('missing required signal degrades even when the call succeeded', () => {
  const d = run(snap(), [], evaluation('partial', { goal_deviation: noul('goal_deviation', 0.1) }, ['goal_deviation', 'payee_relation']));
  assert.equal(d.recommended, 'HOLD'); assert.match(d.coverage_gaps[0], /payee_relation/);
});

test('experimental semantic mode records hits but never changes the recommendation', () => {
  const d = run(snap(), [], evaluation('ok', { goal_deviation: noul('goal_deviation', 0.97) }, ['goal_deviation']));
  assert.equal(d.recommended, 'NO_CONFIGURED_RISK');
  assert.equal(d.semantic.hits.find(h => h.question_id === 'goal_deviation')?.band, 'experimental_review');
});

test('calibrated mode cannot be enabled without a known calibration', () => {
  const v = validatePolicy({ ...DEFAULT_POLICY, semantic: { ...DEFAULT_POLICY.semantic, mode: 'calibrated', calibration_id: 'made-up' } });
  assert.equal(v.ok, false);
});

test('completed boundaries get investigations, never allow/deny', () => {
  assert.equal(wouldHaveAction('BLOCK', 'post_tool'), 'open_investigation');
  assert.equal(wouldHaveAction('NO_CONFIGURED_RISK', 'post_generation'), null);
});
