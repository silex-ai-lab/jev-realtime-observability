// T4: HOLD/REVIEW decisions open exactly one review task (worker and preflight); resolving writes
// human_reviewed labels, closes the task and audits it; it never changes the decision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startGateAHarness, type GateAHarness } from '../helpers/harness.ts';
import * as repos from '../../server/storage/repos.ts';
import { openReviewTask, openSampledReviewTask } from '../../server/storage/reviews.ts';
import { RUBRIC } from '../../server/state/index.ts';
import type { EvaluationRecord } from '../../contracts/judge.ts';
import type { PolicyDecision } from '../../contracts/decision.ts';
import type { ReviewTask } from '../../contracts/labels.ts';

const worker = { autostart: false, leaseMs: 50, realtimeTtlMs: 60_000 };

async function decisionsOf(h: GateAHarness, runId: string): Promise<PolicyDecision[]> {
  const { body } = await h.json<{ timeline: Array<{ decisions: PolicyDecision[] }> }>('GET', `/v1/runs/${runId}`);
  return body.timeline.flatMap(t => t.decisions);
}
async function openTasks(h: GateAHarness, tenant: 'alpha' | 'beta' = 'alpha'): Promise<ReviewTask[]> {
  const { response, body } = await h.json<{ reviews: ReviewTask[] }>('GET', '/v1/reviews?status=open', { tenant });
  assert.equal(response.status, 200);
  return body.reviews;
}

test('shadow: every original HOLD/REVIEW decision opens exactly one task, also on redelivery; others open none', async () => {
  const h = await startGateAHarness({ worker });
  try {
    const run = await h.app.runScenario('t-alpha', 'S4');
    await h.app.worker.drain();
    const decisions = (await decisionsOf(h, run.run_id));
    const held = decisions.filter(d => d.recommended === 'HOLD' || d.recommended === 'REVIEW');
    assert.ok(held.length >= 1, 'S4 (missing approval) must produce a HOLD');
    let tasks = await openTasks(h);
    assert.deepEqual(tasks.map(t => t.decision_id).sort(), held.map(d => d.decision_id).sort());
    assert.ok(tasks.every(t => t.body.path === 'worker' && t.body.run_id === run.run_id));

    // Redelivery: put the held event's completed realtime job back in the queue (as an expired lease would)
    // and prove the worker really processed it again, without a second decision or task.
    const job = async () => (await h.db.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM evaluation_jobs WHERE tenant_id = 't-alpha' AND event_id = $1 AND kind = 'realtime'`, [held[0].event_id])).rows[0];
    const before = await job();
    assert.equal(before.status, 'done');
    await h.db.query(`UPDATE evaluation_jobs SET status = 'queued', lease_until = NULL, finished_at = NULL
      WHERE tenant_id = 't-alpha' AND event_id = $1 AND kind = 'realtime'`, [held[0].event_id]);
    await h.app.worker.drain();
    const after = await job();
    assert.equal(after.status, 'done');
    assert.equal(after.attempts, before.attempts + 1, 'the redelivered job was leased and completed again');
    const originals = await h.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM decisions WHERE tenant_id = 't-alpha' AND event_id = $1 AND replay_of IS NULL`, [held[0].event_id]);
    assert.equal(originals.rows[0].n, 1, 'still exactly one original decision');
    tasks = await openTasks(h);
    assert.equal(tasks.length, held.length);
    assert.equal(tasks.filter(t => t.decision_id === held[0].decision_id).length, 1);

    // Separately: the insert itself is idempotent per decision.
    assert.equal(await h.db.tx(q => openReviewTask(q, held[0], { path: 'worker', run_id: run.run_id, tool: null })), null);

    // A policy-only replay of a held decision opens no task.
    const policy = (await h.json<{ policy: object }>('GET', '/v1/policies/active')).body.policy;
    const rep = await h.json('POST', '/v1/replays', { body: { kind: 'policy_only', policy, decision_ids: [held[0].decision_id] } });
    assert.equal(rep.response.status, 200);
    assert.equal((await openTasks(h)).length, held.length);
    // Tenant isolation: beta sees none of alpha's tasks.
    assert.equal((await openTasks(h, 'beta')).length, 0);
  } finally { await h.close(); }
});

test('gate: a held preflight opens one task on the preflight path', async () => {
  const h = await startGateAHarness({ worker, sourceMode: 'live_sandbox_gate' });
  try {
    const run = await h.app.runScenario('t-alpha', 'S4');
    await h.app.worker.drain();
    const tasks = (await openTasks(h)).filter(t => t.body.path === 'preflight');
    assert.equal(tasks.length, 1, 'the held payment opens exactly one preflight task');
    const d = await repos.getDecision(h.db, 't-alpha', tasks[0].decision_id);
    assert.equal(d?.recommended, 'HOLD');
    assert.equal(tasks[0].body.run_id, run.run_id);
    const byDecision = new Set((await openTasks(h)).map(t => t.decision_id));
    assert.equal(byDecision.size, (await openTasks(h)).length, 'one task per decision');
  } finally { await h.close(); }
});

test('resolve: validates answers, writes labels + audit, closes the task, 409 on a second resolve; roles and tenants', async () => {
  const h = await startGateAHarness({ worker });
  try {
    await h.app.runScenario('t-alpha', 'S4');
    await h.app.worker.drain();
    const [task] = await openTasks(h);
    const path = `/v1/reviews/${task.review_id}/resolve`;

    // Reader may read, not resolve; another tenant cannot see it.
    assert.equal((await h.request('GET', `/v1/reviews/${task.review_id}`)).status, 200);
    assert.equal((await h.request('POST', path, { body: { outcome: 'deny', answers: {} } })).status, 403);
    assert.equal((await h.request('GET', `/v1/reviews/${task.review_id}`, { tenant: 'beta' })).status, 404);
    assert.equal((await h.request('POST', path, { tenant: 'beta', role: 'admin', body: { outcome: 'deny', answers: {} } })).status, 404);

    // An invalid answer rejects the whole call and leaves the task open with no labels.
    const bad = await h.request('POST', path, { role: 'admin', body: { outcome: 'deny', answers: { semantic_impact: 'huge' } } });
    assert.equal(bad.status, 400);
    assert.equal((await openTasks(h)).some(t => t.review_id === task.review_id), true);
    const before = await h.json<{ labels: unknown[] }>('GET', `/v1/labels?ref=${task.body.snapshot_id}`);
    assert.equal(before.body.labels.length, 0);

    const decisionBefore = await repos.getDecision(h.db, 't-alpha', task.decision_id);
    const ok = await h.json<{ status: string; labels: Array<{ evidence_class: string; ref: string; source: string }> }>('POST', path,
      { role: 'admin', body: { outcome: 'deny', answers: { semantic_impact: 'material', goal_deviation: true } } });
    assert.equal(ok.response.status, 200);
    assert.equal(ok.body.status, 'resolved_deny');
    assert.equal(ok.body.labels.length, 2);
    assert.ok(ok.body.labels.every(l => l.evidence_class === 'human_reviewed' && l.ref === task.body.snapshot_id && l.source === `review:${task.review_id}`));
    const listed = await h.json<{ labels: Array<{ question_id: string; value: unknown }> }>('GET', `/v1/labels?ref=${task.body.snapshot_id}`);
    assert.deepEqual(listed.body.labels.map(l => [l.question_id, l.value]).sort(), [['goal_deviation', true], ['semantic_impact', 'material']]);
    assert.equal((await openTasks(h)).some(t => t.review_id === task.review_id), false);
    const audit = await h.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = 't-alpha' AND action = 'review_resolved'`);
    assert.equal(audit.rows[0].n, 1);
    // Resolving never changes the decision (plan D3).
    assert.deepEqual(await repos.getDecision(h.db, 't-alpha', task.decision_id), decisionBefore);

    const again = await h.request('POST', path, { role: 'admin', body: { outcome: 'allow', answers: {} } });
    assert.equal(again.status, 409);
  } finally { await h.close(); }
});

test('question set (batch 2 D4): S4 gets the whole rubric with wire definitions, stable when a diagnostic arrives later', async () => {
  const h = await startGateAHarness({ worker });
  try {
    await h.app.runScenario('t-alpha', 'S4');
    await h.app.worker.drain();
    const [task] = await openTasks(h);
    assert.equal(task.body.evaluation_id, null, 'S4 is a hard-rule HOLD with no evaluation');
    const got = await h.json<{ questions: Record<string, { type: string; instructions: string }>; snapshot: { judge_view: { state: string } } }>('GET', `/v1/reviews/${task.review_id}`);
    assert.deepEqual(Object.keys(got.body.questions).sort(), Object.keys(RUBRIC.questions).sort());
    assert.equal(got.body.questions.payee_relation.type, 'choice');
    assert.ok(got.body.questions.semantic_impact.instructions.length > 0);
    assert.ok(got.body.snapshot.judge_view.state.length > 0, 'the frozen judge view is returned');

    // A diagnostic evaluation with a narrower question set arrives after the GET; resolve must still accept the
    // questions the GET offered.
    const decision = (await repos.getDecision(h.db, 't-alpha', task.decision_id))!;
    await h.db.tx(q => repos.insertEvaluation(q, { evaluation_id: `eval-diag-${task.review_id}`, tenant_id: 't-alpha', event_id: decision.event_id,
      snapshot_id: `snap-diag-${task.review_id}`, kind: 'diagnostic', rubric_id: RUBRIC.rubric_id, question_ids: ['goal_deviation'], required_question_ids: [],
      judge_source: null, served_model: null, request_hash: '', client_request_id: `diag-${task.review_id}`, vendor_request_id: null, status: 'ok', http_status: 200,
      attempts: 1, judge_http_rtt_ms: 1, vendor_latency_ms: null, usage: null, billing: 'none', signals: {}, errors: [],
      started_at: new Date().toISOString(), finished_at: new Date().toISOString() } as EvaluationRecord));
    const ok = await h.json<{ labels: Array<{ question_id: string; value: unknown }> }>('POST', `/v1/reviews/${task.review_id}/resolve`,
      { role: 'admin', body: { outcome: 'deny', answers: { instruction_override: false, payee_relation: 'different_entity', semantic_impact: 'severe' } } });
    assert.equal(ok.response.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.labels.map(l => [l.question_id, l.value]).sort(),
      [['instruction_override', false], ['payee_relation', 'different_entity'], ['semantic_impact', 'severe']]);
  } finally { await h.close(); }
});

test('sampler seam (batch 2 F0): a sampled task uses its evaluation\'s questions; POST /v1/reviews/sample is admin-only and validates budget', async () => {
  const h = await startGateAHarness({ worker });
  try {
    const run = await h.app.runScenario('t-alpha', 'S1');
    await h.app.worker.drain();
    const decisions = await decisionsOf(h, run.run_id);
    const d = decisions.find(x => x.evaluation_id);
    assert.ok(d, 'S1 has a decision with an evaluation');
    const ev = (await repos.getEvaluation(h.db, 't-alpha', d.evaluation_id!))!;
    assert.ok(ev.question_ids.length > 0 && ev.question_ids.length < Object.keys(RUBRIC.questions).length);
    await h.db.query(`DELETE FROM review_tasks WHERE tenant_id = 't-alpha' AND decision_id = $1`, [d.decision_id]);
    const id = await h.db.tx(q => openSampledReviewTask(q, d, { run_id: run.run_id, tool: null }, 'uncertain', ev.evaluation_id));
    assert.ok(id);
    assert.equal(await h.db.tx(q => openSampledReviewTask(q, d, { run_id: run.run_id, tool: null }, 'uncertain', ev.evaluation_id)), null, 'idempotent per decision');
    const got = await h.json<{ review: ReviewTask; questions: Record<string, unknown> }>('GET', `/v1/reviews/${id}`);
    assert.equal(got.body.review.body.path, 'sampler');
    assert.equal(got.body.review.body.sample_reason, 'uncertain');
    assert.deepEqual(Object.keys(got.body.questions).sort(), [...ev.question_ids].sort());
    const outside = Object.keys(RUBRIC.questions).find(q => !ev.question_ids.includes(q))!;
    const r = await h.request('POST', `/v1/reviews/${id}/resolve`, { role: 'admin', body: { outcome: 'allow', answers: { [outside]: RUBRIC.questions[outside].type === 'noul' ? true : 'x' } } });
    assert.equal(r.status, 400);

    assert.equal((await h.request('POST', '/v1/reviews/sample', { body: {} })).status, 403);
    for (const budget of [0, 101, 1.5, '5']) assert.equal((await h.request('POST', '/v1/reviews/sample', { role: 'admin', body: { budget } })).status, 400);
    const s = await h.json<{ opened: unknown[] }>('POST', '/v1/reviews/sample', { role: 'admin', body: {} });
    assert.equal(s.response.status, 200);
    assert.ok(Array.isArray(s.body.opened));
  } finally { await h.close(); }
});
