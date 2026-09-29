// T4: HOLD/REVIEW decisions open exactly one review task (worker and preflight); resolving writes
// human_reviewed labels, closes the task and audits it; it never changes the decision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startGateAHarness, type GateAHarness } from '../helpers/harness.ts';
import * as repos from '../../server/storage/repos.ts';
import { openReviewTask } from '../../server/storage/reviews.ts';
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

    // Redelivery: re-enqueue the held event's realtime job; the worker must not add a decision or a task.
    await h.db.tx(q => repos.enqueueJob(q, 't-alpha', held[0].event_id, 'realtime', 0, new Date(Date.now() + 60_000).toISOString()));
    await h.app.worker.drain();
    // And the insert itself is idempotent per decision.
    assert.equal(await h.db.tx(q => openReviewTask(q, held[0], { path: 'worker', run_id: run.run_id, tool: null })), null);
    tasks = await openTasks(h);
    assert.equal(tasks.length, held.length);

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
