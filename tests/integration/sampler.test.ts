// T7: active-learning sampler (plan batch 2 D3). Seeds decisions/evaluations/snapshots directly and checks
// the three classes, priority order, budget, idempotency, tenant isolation, and the negative fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, type Db } from '../../server/storage/db.ts';
import { sampleForReview } from '../../server/labeling/index.ts';
import { startGateAHarness } from '../helpers/harness.ts';
import type { PolicyDecision, RuleResult } from '../../contracts/decision.ts';
import type { EvaluationRecord, Signal } from '../../contracts/judge.ts';

const now = new Date().toISOString();
const T = (m: number) => `2026-01-01T00:${String(m).padStart(2, '0')}:00.000Z`;

function noul(p: number): Signal {
  return { question_id: 'x', type: 'noul', raw_probability: p, choice: null, probabilities: null, vendor_confidence: null, score: null, legend: null, margin_local: null, p_calibrated: null, calibration_id: null };
}
const PASS: RuleResult = { rule_id: 'r1', verdict: 'PASS', reason: '', evidence_refs: [], authoritative_source: 'sandbox' };
const HOLD: RuleResult = { rule_id: 'r1', verdict: 'HOLD', reason: '', evidence_refs: [], authoritative_source: 'sandbox' };

function decBody(p: { decision_id: string; event_id: string; evaluation_id: string | null; snapshot_id: string; rule_results: RuleResult[] }): PolicyDecision {
  return {
    decision_id: p.decision_id, tenant_id: 't-alpha', event_id: p.event_id, evaluation_id: p.evaluation_id,
    snapshot_id: p.snapshot_id, policy_version: 'policy-a1',
    provenance: { source_mode: 'live_sandbox_shadow', judge_source: null, tool_environment: 'sandbox', enforcement_mode: 'shadow' },
    recommended: 'NO_CONFIGURED_RISK', decided_by: 'default', would_have: null, enforced_action: null,
    reasons: [], rule_results: p.rule_results, semantic: { calibrated: false, hits: [] }, coverage_gaps: [],
    timings: { ingest_to_signal_ms: null, snapshot_ms: null, rules_ms: null, judge_http_rtt_ms: null, policy_ms: null }, created_at: now,
  };
}

function evalBody(p: { evaluation_id: string; event_id: string; snapshot_id: string; kind: EvaluationRecord['kind'];
  question_ids: string[]; required_question_ids: string[]; signals: Record<string, Signal>; served_run: string }): EvaluationRecord {
  return {
    evaluation_id: p.evaluation_id, tenant_id: 't-alpha', event_id: p.event_id, snapshot_id: p.snapshot_id, kind: p.kind,
    rubric_id: 'ap-runtime-semantic:v1', question_ids: p.question_ids, required_question_ids: p.required_question_ids,
    judge_source: null, served_model: { backend: 'stub', run: p.served_run, base: null, revision: null, temperature: null, runtime: 'mlx/bfloat16/mps' },
    request_hash: '', client_request_id: `req-${p.evaluation_id}`, vendor_request_id: null, status: 'ok', http_status: 200,
    attempts: 1, judge_http_rtt_ms: null, vendor_latency_ms: null, usage: null, billing: 'local_compute', signals: p.signals,
    errors: [], started_at: now, finished_at: now,
  };
}

async function freshDb(): Promise<Db> { const db = await openDb(); await migrate(db); return db; }

async function seedDecision(db: Db, d: PolicyDecision, at: string, replayOf: string | null = null) {
  await db.query(
    `INSERT INTO decisions (tenant_id, decision_id, event_id, evaluation_id, policy_version, recommended, replay_of, body, created_at)
     VALUES ('t-alpha',$1,$2,$3,'policy-a1',$4,$5,$6,$7::timestamptz)`,
    [d.decision_id, d.event_id, d.evaluation_id, d.recommended, replayOf, JSON.stringify(d), at]);
}

async function seedEvaluation(db: Db, e: EvaluationRecord, status: string, at: string) {
  await db.query(
    `INSERT INTO evaluations (tenant_id, evaluation_id, event_id, snapshot_id, kind, status, judge_source, body, created_at)
     VALUES ('t-alpha',$1,$2,$3,$4,$5,NULL,$6,$7::timestamptz)`,
    [e.evaluation_id, e.event_id, e.snapshot_id, e.kind, status, JSON.stringify(e), at]);
}

async function seedSnapshot(db: Db, snapshotId: string, eventId: string, runId: string, tool: string, at: string) {
  await db.query(
    `INSERT INTO snapshots (tenant_id, snapshot_id, event_id, revision, body, created_at) VALUES ('t-alpha',$1,$2,1,$3,$4::timestamptz)`,
    [snapshotId, eventId, JSON.stringify({ judge_view: { state: `STATE-${snapshotId}`, token_estimate: 5, truncated: false }, run_id: runId, candidate_action: { tool, operation_id: 'op', impact: 'payment', args_summary: {} } }), at]);
}

async function taskBodies(db: Db): Promise<Array<{ decision_id: string; sample_reason: string; evaluation_id: string | null; path: string }>> {
  const r = await db.query<{ decision_id: string; body: { sample_reason?: string; evaluation_id: string | null; path: string } }>(
    `SELECT decision_id, body FROM review_tasks WHERE tenant_id = 't-alpha' ORDER BY created_at, review_id`);
  return r.rows.map(x => ({ decision_id: x.decision_id, sample_reason: x.body.sample_reason ?? '', evaluation_id: x.body.evaluation_id, path: x.body.path }));
}

test('picks each class in priority order, with the sampling evaluation recorded', async () => {
  const db = await freshDb();
  try {
    // cross_judge (newest), judge_flags, uncertain — each distinct, newest-first within its class.
    const cross = decBody({ decision_id: 'd-cross', event_id: 'ev-cross', evaluation_id: null, snapshot_id: 'snap-cross', rule_results: [PASS] });
    await seedDecision(db, cross, T(3));
    await seedSnapshot(db, 'snap-cross', 'ev-cross', 'run-x', 'payments.execute', T(3));
    // two evaluations of the same snapshot, different served runs, opposite sides on goal_deviation.
    await seedEvaluation(db, evalBody({ evaluation_id: 'e-cross-rt', event_id: 'ev-cross', snapshot_id: 'snap-cross', kind: 'realtime', question_ids: ['goal_deviation'], required_question_ids: ['goal_deviation'], signals: { goal_deviation: noul(0.2) }, served_run: 'kev-0.8b' }), 'ok', T(3));
    await seedEvaluation(db, evalBody({ evaluation_id: 'e-cross-reeval', event_id: 'ev-cross', snapshot_id: 'snap-cross', kind: 'model_reeval', question_ids: ['goal_deviation'], required_question_ids: ['goal_deviation'], signals: { goal_deviation: noul(0.8) }, served_run: 'kev-0.8b-ft' }), 'ok', T(4));

    const unruled = decBody({ decision_id: 'd-unruled', event_id: 'ev-unruled', evaluation_id: 'e-unruled', snapshot_id: 'snap-unruled', rule_results: [PASS] });
    await seedDecision(db, unruled, T(2));
    await seedSnapshot(db, 'snap-unruled', 'ev-unruled', 'run-x', 'payments.execute', T(2));
    await seedEvaluation(db, evalBody({ evaluation_id: 'e-unruled', event_id: 'ev-unruled', snapshot_id: 'snap-unruled', kind: 'realtime', question_ids: ['goal_deviation'], required_question_ids: ['goal_deviation'], signals: { goal_deviation: noul(0.8) }, served_run: 'kev-0.8b' }), 'ok', T(2));

    const unc = decBody({ decision_id: 'd-unc', event_id: 'ev-unc', evaluation_id: 'e-unc', snapshot_id: 'snap-unc', rule_results: [PASS] });
    await seedDecision(db, unc, T(1));
    await seedSnapshot(db, 'snap-unc', 'ev-unc', 'run-x', 'payments.execute', T(1));
    await seedEvaluation(db, evalBody({ evaluation_id: 'e-unc', event_id: 'ev-unc', snapshot_id: 'snap-unc', kind: 'realtime', question_ids: ['goal_deviation'], required_question_ids: ['goal_deviation'], signals: { goal_deviation: noul(0.5) }, served_run: 'kev-0.8b' }), 'ok', T(1));

    const opened = await sampleForReview(db, 't-alpha', 20);
    assert.deepEqual(opened.map(o => o.reason), ['uncertain', 'judge_flags_unruled_risk', 'cross_judge_disagreement'], 'priority order holds');
    assert.deepEqual(opened.map(o => o.decision_id), ['d-unc', 'd-unruled', 'd-cross']);

    const bodies = await taskBodies(db);
    assert.deepEqual(bodies.map(b => [b.decision_id, b.sample_reason, b.path]).sort(),
      [['d-cross', 'cross_judge_disagreement', 'sampler'], ['d-unc', 'uncertain', 'sampler'], ['d-unruled', 'judge_flags_unruled_risk', 'sampler']]);
    assert.equal(bodies.find(b => b.decision_id === 'd-cross')!.evaluation_id, 'e-cross-reeval', 'class 3 uses the newer evaluation');
    assert.equal(bodies.find(b => b.decision_id === 'd-unc')!.evaluation_id, 'e-unc');
    // Each opened task is announced on the outbox, so every connected review panel refreshes.
    const out = await db.query<{ ref_id: string; payload: { status: string; sample_reason: string } }>(`SELECT ref_id, payload FROM outbox WHERE tenant_id = 't-alpha' AND kind = 'review'`);
    assert.deepEqual(out.rows.map(r => r.ref_id).sort(), opened.map(o => o.review_id).sort());
    assert.ok(out.rows.every(r => r.payload.status === 'open' && r.payload.sample_reason));
  } finally { await db.close(); }
});

test('negatives: benign claim, approval HOLD with low risk, empty required set, failed signals, same-model re-ask, different snapshots', async () => {
  const db = await freshDb();
  try {
    // benign completion claim: claim_asserts_completion 0.9 is not a risk question.
    const c1 = decBody({ decision_id: 'd-claim', event_id: 'ev-claim', evaluation_id: 'e-claim', snapshot_id: 'snap-claim', rule_results: [PASS] });
    await seedDecision(db, c1, T(1));
    await seedSnapshot(db, 'snap-claim', 'ev-claim', 'run-x', 'email.send', T(1));
    await seedEvaluation(db, evalBody({ evaluation_id: 'e-claim', event_id: 'ev-claim', snapshot_id: 'snap-claim', kind: 'realtime', question_ids: ['claim_asserts_completion'], required_question_ids: ['claim_asserts_completion'], signals: { claim_asserts_completion: noul(0.9) }, served_run: 'kev-0.8b' }), 'ok', T(1));

    // approval HOLD with low risk answers: a rule held it, judge saw low risk — not sampled.
    const c2 = decBody({ decision_id: 'd-hold', event_id: 'ev-hold', evaluation_id: 'e-hold', snapshot_id: 'snap-hold', rule_results: [HOLD] });
    await seedDecision(db, c2, T(2));
    await seedSnapshot(db, 'snap-hold', 'ev-hold', 'run-x', 'payments.execute', T(2));
    await seedEvaluation(db, evalBody({ evaluation_id: 'e-hold', event_id: 'ev-hold', snapshot_id: 'snap-hold', kind: 'realtime', question_ids: ['goal_deviation'], required_question_ids: ['goal_deviation'], signals: { goal_deviation: noul(0.1) }, served_run: 'kev-0.8b' }), 'ok', T(2));

    // empty required set: risk p 0.5 but nothing required.
    const c3 = decBody({ decision_id: 'd-empty', event_id: 'ev-empty', evaluation_id: 'e-empty', snapshot_id: 'snap-empty', rule_results: [PASS] });
    await seedDecision(db, c3, T(3));
    await seedSnapshot(db, 'snap-empty', 'ev-empty', 'run-x', 'payments.execute', T(3));
    await seedEvaluation(db, evalBody({ evaluation_id: 'e-empty', event_id: 'ev-empty', snapshot_id: 'snap-empty', kind: 'realtime', question_ids: ['goal_deviation'], required_question_ids: [], signals: { goal_deviation: noul(0.5) }, served_run: 'kev-0.8b' }), 'ok', T(3));

    // failed (timeout) evaluation: never qualifies.
    const c4 = decBody({ decision_id: 'd-failed', event_id: 'ev-failed', evaluation_id: 'e-failed', snapshot_id: 'snap-failed', rule_results: [PASS] });
    await seedDecision(db, c4, T(4));
    await seedSnapshot(db, 'snap-failed', 'ev-failed', 'run-x', 'payments.execute', T(4));
    await seedEvaluation(db, evalBody({ evaluation_id: 'e-failed', event_id: 'ev-failed', snapshot_id: 'snap-failed', kind: 'realtime', question_ids: ['goal_deviation'], required_question_ids: ['goal_deviation'], signals: { goal_deviation: noul(0.5) }, served_run: 'kev-0.8b' }), 'timeout', T(4));

    // same-model re-ask: same snapshot, same run.
    const c5 = decBody({ decision_id: 'd-samemodel', event_id: 'ev-samemodel', evaluation_id: null, snapshot_id: 'snap-samemodel', rule_results: [PASS] });
    await seedDecision(db, c5, T(5));
    await seedSnapshot(db, 'snap-samemodel', 'ev-samemodel', 'run-x', 'payments.execute', T(5));
    await seedEvaluation(db, evalBody({ evaluation_id: 'e-samemodel-1', event_id: 'ev-samemodel', snapshot_id: 'snap-samemodel', kind: 'realtime', question_ids: ['goal_deviation'], required_question_ids: ['goal_deviation'], signals: { goal_deviation: noul(0.2) }, served_run: 'kev-0.8b' }), 'ok', T(5));
    await seedEvaluation(db, evalBody({ evaluation_id: 'e-samemodel-2', event_id: 'ev-samemodel', snapshot_id: 'snap-samemodel', kind: 'model_reeval', question_ids: ['goal_deviation'], required_question_ids: ['goal_deviation'], signals: { goal_deviation: noul(0.8) }, served_run: 'kev-0.8b' }), 'ok', T(6));

    // different snapshots: disagreeing runs but not the same snapshot.
    const c6 = decBody({ decision_id: 'd-diffsnap', event_id: 'ev-diffsnap', evaluation_id: null, snapshot_id: 'snap-a', rule_results: [PASS] });
    await seedDecision(db, c6, T(6));
    await seedSnapshot(db, 'snap-a', 'ev-diffsnap', 'run-x', 'payments.execute', T(6));
    await seedSnapshot(db, 'snap-b', 'ev-other', 'run-x', 'payments.execute', T(6));
    await seedEvaluation(db, evalBody({ evaluation_id: 'e-diff-1', event_id: 'ev-diffsnap', snapshot_id: 'snap-a', kind: 'realtime', question_ids: ['goal_deviation'], required_question_ids: ['goal_deviation'], signals: { goal_deviation: noul(0.2) }, served_run: 'kev-0.8b' }), 'ok', T(6));
    await seedEvaluation(db, evalBody({ evaluation_id: 'e-diff-2', event_id: 'ev-other', snapshot_id: 'snap-b', kind: 'realtime', question_ids: ['goal_deviation'], required_question_ids: ['goal_deviation'], signals: { goal_deviation: noul(0.8) }, served_run: 'kev-0.8b-ft' }), 'ok', T(7));

    const opened = await sampleForReview(db, 't-alpha', 20);
    assert.equal(opened.length, 0, `expected no picks, got ${JSON.stringify(opened)}`);
  } finally { await db.close(); }
});

test('the sample route requires admin: reader → 403, admin → 200 in keys mode', async () => {
  const h = await startGateAHarness({ worker: { autostart: false, leaseMs: 50, realtimeTtlMs: 60_000 } });
  try {
    assert.equal((await h.request('POST', '/v1/reviews/sample', { tenant: 'alpha', role: 'reader', body: { budget: 5 } })).status, 403);
    const ok = await h.request('POST', '/v1/reviews/sample', { tenant: 'alpha', role: 'admin', body: { budget: 5 } });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(await ok.text()), { opened: [] });
  } finally { await h.close(); }
});

test('budget caps, second call opens nothing, replays and other tenants never sampled, reader role is route-level', async () => {
  const db = await freshDb();
  try {
    for (let i = 1; i <= 5; i++) {
      const d = decBody({ decision_id: `d-${i}`, event_id: `ev-${i}`, evaluation_id: `e-${i}`, snapshot_id: `snap-${i}`, rule_results: [PASS] });
      await seedDecision(db, d, T(i));
      await seedSnapshot(db, `snap-${i}`, `ev-${i}`, 'run-x', 'payments.execute', T(i));
      await seedEvaluation(db, evalBody({ evaluation_id: `e-${i}`, event_id: `ev-${i}`, snapshot_id: `snap-${i}`, kind: 'realtime', question_ids: ['goal_deviation'], required_question_ids: ['goal_deviation'], signals: { goal_deviation: noul(0.5) }, served_run: 'kev-0.8b' }), 'ok', T(i));
    }
    // A replay decision (replay_of set) with an uncertain evaluation must never be sampled.
    const replay = decBody({ decision_id: 'd-replay', event_id: 'ev-replay', evaluation_id: 'e-replay', snapshot_id: 'snap-replay', rule_results: [PASS] });
    await seedDecision(db, replay, T(6), 'd-1');
    await seedSnapshot(db, 'snap-replay', 'ev-replay', 'run-x', 'payments.execute', T(6));
    await seedEvaluation(db, evalBody({ evaluation_id: 'e-replay', event_id: 'ev-replay', snapshot_id: 'snap-replay', kind: 'realtime', question_ids: ['goal_deviation'], required_question_ids: ['goal_deviation'], signals: { goal_deviation: noul(0.5) }, served_run: 'kev-0.8b' }), 'ok', T(6));
    // Another tenant's decision with an uncertain evaluation must never be sampled.
    await db.query(
      `INSERT INTO decisions (tenant_id, decision_id, event_id, evaluation_id, policy_version, recommended, replay_of, body, created_at)
       VALUES ('t-beta','d-beta','ev-beta','e-beta','policy-a1','NO_CONFIGURED_RISK',NULL,$1,$2::timestamptz)`,
      [JSON.stringify(decBody({ decision_id: 'd-beta', event_id: 'ev-beta', evaluation_id: 'e-beta', snapshot_id: 'snap-beta', rule_results: [PASS] })), T(6)]);
    await db.query(
      `INSERT INTO evaluations (tenant_id, evaluation_id, event_id, snapshot_id, kind, status, judge_source, body, created_at)
       VALUES ('t-beta','e-beta','ev-beta','snap-beta','realtime','ok',NULL,$1,$2::timestamptz)`,
      [JSON.stringify(evalBody({ evaluation_id: 'e-beta', event_id: 'ev-beta', snapshot_id: 'snap-beta', kind: 'realtime', question_ids: ['goal_deviation'], required_question_ids: ['goal_deviation'], signals: { goal_deviation: noul(0.5) }, served_run: 'kev-0.8b' })), T(6)]);

    const first = await sampleForReview(db, 't-alpha', 3);
    assert.equal(first.length, 3, 'budget 3 caps the five uncertain candidates');
    assert.deepEqual(first.map(o => o.decision_id), ['d-5', 'd-4', 'd-3'], 'newest first within the class');

    const second = await sampleForReview(db, 't-alpha', 20);
    assert.deepEqual(second.map(o => o.decision_id), ['d-2', 'd-1'], 'second call opens the rest, nothing duplicated');
    assert.ok(!second.some(o => o.decision_id === 'd-replay'), 'replay never sampled');
    assert.ok(!second.some(o => o.decision_id === 'd-beta'), 'other tenant never sampled');
  } finally { await db.close(); }
});

test('scale (N3): 5,000 task-less decisions with evaluations sample in under 1 s on PGlite', async () => {
  const db = await freshDb();
  try {
    // 5,000 unremarkable realtime decisions (goal_deviation 0.1, no hard rule), seeded in bulk from one template each.
    const dec = decBody({ decision_id: 'tpl', event_id: 'tpl', evaluation_id: 'tpl', snapshot_id: 'tpl', rule_results: [PASS] });
    const ev = evalBody({ evaluation_id: 'tpl', event_id: 'tpl', snapshot_id: 'tpl', kind: 'realtime', question_ids: ['goal_deviation'], required_question_ids: ['goal_deviation'], signals: { goal_deviation: noul(0.1) }, served_run: 'kev-0.8b' });
    await db.query(
      `INSERT INTO evaluations (tenant_id, evaluation_id, event_id, snapshot_id, kind, status, judge_source, body, created_at)
       SELECT 't-alpha', 'e-' || i, 'ev-' || i, 's-' || i, 'realtime', 'ok', NULL,
              $1::jsonb || jsonb_build_object('evaluation_id', 'e-' || i, 'event_id', 'ev-' || i, 'snapshot_id', 's-' || i),
              '2026-01-01T00:00:00Z'::timestamptz + i * interval '1 second'
       FROM generate_series(1, 5000) AS i`, [JSON.stringify(ev)]);
    await db.query(
      `INSERT INTO decisions (tenant_id, decision_id, event_id, evaluation_id, policy_version, recommended, replay_of, body, created_at)
       SELECT 't-alpha', 'd-' || i, 'ev-' || i, 'e-' || i, 'policy-a1', 'NO_CONFIGURED_RISK', NULL,
              $1::jsonb || jsonb_build_object('decision_id', 'd-' || i, 'event_id', 'ev-' || i, 'evaluation_id', 'e-' || i, 'snapshot_id', 's-' || i),
              '2026-01-01T00:00:00Z'::timestamptz + i * interval '1 second'
       FROM generate_series(1, 5000) AS i`, [JSON.stringify(dec)]);
    // The oldest decision is the only uncertain one; the second oldest has a disagreeing re-ask by another model.
    await db.query(`UPDATE evaluations SET body = jsonb_set(body, '{signals,goal_deviation,raw_probability}', '0.5') WHERE evaluation_id = 'e-1'`);
    await seedEvaluation(db, evalBody({ evaluation_id: 'e-2-reeval', event_id: 'ev-2', snapshot_id: 's-2', kind: 'model_reeval', question_ids: ['goal_deviation'], required_question_ids: ['goal_deviation'], signals: { goal_deviation: noul(0.9) }, served_run: 'kev-0.8b-ft' }), 'ok', T(59));
    await seedSnapshot(db, 's-1', 'ev-1', 'run-1', 'payments.execute', T(0));
    await seedSnapshot(db, 's-2', 'ev-2', 'run-2', 'payments.execute', T(0));

    const t0 = performance.now();
    const opened = await sampleForReview(db, 't-alpha', 20);
    const elapsed = performance.now() - t0;
    assert.deepEqual(opened.map(o => [o.decision_id, o.reason]), [['d-1', 'uncertain'], ['d-2', 'cross_judge_disagreement']]);
    assert.ok(elapsed < 1000, `sampleForReview took ${Math.round(elapsed)} ms over 5,000 decisions`);
  } finally { await db.close(); }
});
