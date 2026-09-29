// T5: POST/GET /v1/labels. Values are validated against the question type, refs must belong to the
// caller's tenant, and only admin may write (every evidence class).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startGateAHarness } from '../helpers/harness.ts';
import { createApp } from '../../server/app.ts';
import type { EvaluationRecord } from '../../contracts/judge.ts';
import type { PolicyDecision } from '../../contracts/decision.ts';

test('labels: type validation, ref ownership, admin-only writes, tenant-scoped reads', async () => {
  const h = await startGateAHarness({ worker: { autostart: false, leaseMs: 50, realtimeTtlMs: 60_000 } });
  try {
    const run = await h.app.runScenario('t-alpha', 'S1');
    await h.app.worker.drain();
    const { body } = await h.json<{ timeline: Array<{ evaluations: EvaluationRecord[]; decisions: PolicyDecision[] }> }>('GET', `/v1/runs/${run.run_id}`);
    const snapshotId = body.timeline.flatMap(t => t.decisions)[0].snapshot_id;
    const evaluationId = body.timeline.flatMap(t => t.evaluations)[0]?.evaluation_id;
    const post = (b: object, tenant: 'alpha' | 'beta' = 'alpha', role: 'admin' | 'reader' = 'admin') =>
      h.request('POST', '/v1/labels', { tenant, role, body: { ref: snapshotId, source: 'test', evidence_class: 'human_reviewed', ...b } });

    // Valid values per type.
    assert.equal((await post({ question_id: 'goal_deviation', value: false })).status, 201);
    assert.equal((await post({ question_id: 'payee_relation', value: 'same_entity' })).status, 201);
    assert.equal((await post({ question_id: 'semantic_impact', value: 'none', evidence_class: 'heuristic_derived' })).status, 201);
    if (evaluationId) assert.equal((await post({ ref: evaluationId, question_id: 'claim_support', value: 'supported' })).status, 201);
    // Invalid values.
    assert.equal((await post({ question_id: 'goal_deviation', value: 'yes' })).status, 400);
    assert.equal((await post({ question_id: 'payee_relation', value: 'maybe' })).status, 400);
    assert.equal((await post({ question_id: 'semantic_impact', value: 3 })).status, 400);
    assert.equal((await post({ question_id: 'no_such_question', value: true })).status, 400);
    assert.equal((await post({ question_id: 'constructor', value: true })).status, 400);
    assert.equal((await post({ question_id: '__proto__', value: true })).status, 400);
    assert.equal((await post({ question_id: 'goal_deviation', value: true, evidence_class: 'gut_feeling' })).status, 400);
    // Unknown ref, and another tenant's ref → 404.
    assert.equal((await post({ ref: 'snap-does-not-exist', question_id: 'goal_deviation', value: true })).status, 404);
    assert.equal((await post({ question_id: 'goal_deviation', value: true }, 'beta')).status, 404);
    // Admin only, for every evidence class.
    assert.equal((await post({ question_id: 'goal_deviation', value: true }, 'alpha', 'reader')).status, 403);
    assert.equal((await post({ question_id: 'goal_deviation', value: true, evidence_class: 'heuristic_derived' }, 'alpha', 'reader')).status, 403);

    const listed = await h.json<{ labels: Array<{ ref: string; question_id: string }> }>('GET', `/v1/labels?ref=${snapshotId}`);
    assert.equal(listed.body.labels.length, 3);
    const byQ = await h.json<{ labels: unknown[] }>('GET', `/v1/labels?question_id=payee_relation`);
    assert.equal(byQ.body.labels.length, 1);
    assert.equal((await h.json<{ labels: unknown[] }>('GET', '/v1/labels', { tenant: 'beta' })).body.labels.length, 0);
  } finally { await h.close(); }
});

test('labels: with AUTH_MODE=none the caller acts as admin and may write human_reviewed', async () => {
  const k = (r: string) => `${r}-labels-none-key-0000000`;
  const app = await createApp({ judge: null, sourceMode: 'live_sandbox_shadow', web: false, mirrorOtlp: false,
    tenants: [{ tenant_id: 't-n', name: 'N', keys: { ingest: k('i'), reader: k('r'), gateway: k('g'), admin: k('a') } }],
    worker: { autostart: false, leaseMs: 50, realtimeTtlMs: 60_000 } });
  try {
    const run = await app.runScenario('t-n', 'S1');
    await app.worker.drain();
    const tl = await (await fetch(`${app.url}/v1/runs/${run.run_id}`)).json() as { timeline: Array<{ decisions: PolicyDecision[] }> };
    const ref = tl.timeline.flatMap(t => t.decisions)[0].snapshot_id;
    const r = await fetch(`${app.url}/v1/labels`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref, question_id: 'goal_deviation', value: false, evidence_class: 'human_reviewed', source: 'test' }) });
    assert.equal(r.status, 201);
  } finally { await app.close(); }
});
