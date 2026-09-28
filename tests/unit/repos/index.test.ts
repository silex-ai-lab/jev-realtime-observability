// Repositories over the core schema on in-memory PGlite (openDb() + migrate()).
// Covers duplicate vs conflict on insertEventWithJob, job leasing order and lease expiry,
// tenant scoping of getEvent/readOutbox, and the append-only record round-trips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../../../server/storage/db.ts';
import * as repos from '../../../server/storage/repos.ts';
import { SCHEMA_VERSION } from '../../../contracts/common.ts';
import { sha256 } from '../../../contracts/canonical.ts';
import type { StoredEvent } from '../../../contracts/events.ts';
import type { DecisionSnapshot } from '../../../contracts/snapshot.ts';
import type { EvaluationRecord } from '../../../contracts/judge.ts';
import type { PolicyDecision } from '../../../contracts/decision.ts';

const iso = () => new Date().toISOString();

const makeEvent = (over: Partial<StoredEvent> = {}): StoredEvent => ({
  schema_version: SCHEMA_VERSION, event_id: 'ev-1', run_id: 'run-1', trace_id: '0'.repeat(31) + '1',
  producer_id: 'producer', producer_seq: 1, boundary: 'pre_tool', occurred_at: iso(),
  actor: { kind: 'agent', id: 'agent' }, sources: [], attributes: {},
  tenant_id: 't-alpha', received_at: iso(), ingest_path: 'sdk',
  ...over,
});

const future = (ms = 60_000) => new Date(Date.now() + ms).toISOString();

async function dbWithEvent(event: StoredEvent = makeEvent(), digest = sha256('body'), job: { kind: repos.JobKind; priority: number; not_after: string } | null = { kind: 'realtime', priority: 100, not_after: future() }) {
  const db = await openDb();
  await migrate(db);
  await repos.ensureTenant(db, 't-alpha', 'Alpha');
  const status = await repos.insertEventWithJob(db, event, digest, job);
  return { db, status };
}

test('insertEventWithJob: inserted, then duplicate (same digest), then conflict (different digest)', async () => {
  const db = await openDb();
  await migrate(db);
  await repos.ensureTenant(db, 't-alpha', 'Alpha');

  const ev = makeEvent({ event_id: 'ev-a' });
  assert.equal(await repos.insertEventWithJob(db, ev, sha256('body'), { kind: 'realtime', priority: 100, not_after: future() }), 'inserted');
  assert.equal(await repos.insertEventWithJob(db, ev, sha256('body'), { kind: 'realtime', priority: 100, not_after: future() }), 'duplicate');
  const jobs = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM evaluation_jobs WHERE tenant_id = 't-alpha' AND event_id = 'ev-a'`);
  assert.equal(jobs.rows[0].count, 1, 'duplicate must not create a second job');
  assert.equal(await repos.insertEventWithJob(db, ev, sha256('other'), null), 'conflict');
  const conflicts = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM events WHERE tenant_id = 't-alpha' AND event_id = 'ev-a'`);
  assert.equal(conflicts.rows[0].count, 1, 'conflict must write nothing');
  await db.close();
});

test('insertEventWithJob: same source_event_id with same digest is a duplicate', async () => {
  const db = await openDb();
  await migrate(db);
  await repos.ensureTenant(db, 't-alpha', 'Alpha');
  const a = makeEvent({ event_id: 'ev-src-1', source_event_id: 'shared' });
  const b = makeEvent({ event_id: 'ev-src-2', source_event_id: 'shared' });
  assert.equal(await repos.insertEventWithJob(db, a, sha256('x'), null), 'inserted');
  assert.equal(await repos.insertEventWithJob(db, b, sha256('x'), null), 'duplicate');
  assert.equal(await repos.insertEventWithJob(db, makeEvent({ event_id: 'ev-src-3', source_event_id: 'shared' }), sha256('y'), null), 'conflict');
  await db.close();
});

test('job leasing honors priority then job_id, and re-leases after expiry with attempts++', async () => {
  const db = await openDb();
  await migrate(db);
  await repos.ensureTenant(db, 't-alpha', 'Alpha');
  await repos.insertEventWithJob(db, makeEvent({ event_id: 'e-low' }), sha256('1'), { kind: 'realtime', priority: 50, not_after: future() });
  await repos.insertEventWithJob(db, makeEvent({ event_id: 'e-high-1' }), sha256('2'), { kind: 'realtime', priority: 100, not_after: future() });
  await repos.insertEventWithJob(db, makeEvent({ event_id: 'e-high-2' }), sha256('3'), { kind: 'realtime', priority: 100, not_after: future() });

  const j1 = await repos.leaseJob(db, 60_000);
  const j2 = await repos.leaseJob(db, 60_000);
  const j3 = await repos.leaseJob(db, 60_000);
  assert.equal(j1!.event_id, 'e-high-1');
  assert.equal(j2!.event_id, 'e-high-2');
  assert.equal(j3!.event_id, 'e-low');
  assert.equal(await repos.leaseJob(db, 60_000), null, 'all leased, nothing ready');

  await db.query(`UPDATE evaluation_jobs SET lease_until = now() - interval '1 second' WHERE job_id = $1`, [j1!.job_id]);
  const re = await repos.leaseJob(db, 60_000);
  assert.equal(re!.event_id, 'e-high-1');
  assert.equal(re!.attempts, 2, 're-lease increments attempts');
  await db.close();
});

test('tenant scoping: getEvent and readOutbox never return another tenant', async () => {
  const db = await openDb();
  await migrate(db);
  await repos.ensureTenant(db, 't-alpha', 'Alpha');
  await repos.ensureTenant(db, 't-beta', 'Beta');
  const ev = makeEvent({ event_id: 'ev-scoped', tenant_id: 't-alpha' });
  await repos.insertEventWithJob(db, ev, sha256('1'), null);

  assert.ok(await repos.getEvent(db, 't-alpha', 'ev-scoped'));
  assert.equal(await repos.getEvent(db, 't-beta', 'ev-scoped'), null);

  await repos.appendOutbox(db, { tenant_id: 't-alpha', kind: 'event', ref_id: 'ev-scoped', run_id: 'run-1', payload: { a: 1 } });
  await repos.appendOutbox(db, { tenant_id: 't-beta', kind: 'event', ref_id: 'ev-beta', run_id: 'run-2', payload: { b: 2 } });

  const alpha = await repos.readOutbox(db, 't-alpha', '0', 100);
  const beta = await repos.readOutbox(db, 't-beta', '0', 100);
  assert.deepEqual(alpha.map(x => x.ref_id), ['ev-scoped']);
  assert.deepEqual(beta.map(x => x.ref_id), ['ev-beta']);
  await db.close();
});

test('outbox cursors resume in order', async () => {
  const db = await openDb();
  await migrate(db);
  await repos.ensureTenant(db, 't-alpha', 'Alpha');
  const c1 = await repos.appendOutbox(db, { tenant_id: 't-alpha', kind: 'event', ref_id: 'r1', run_id: null, payload: {} });
  const c2 = await repos.appendOutbox(db, { tenant_id: 't-alpha', kind: 'event', ref_id: 'r2', run_id: null, payload: {} });
  const after = await repos.readOutbox(db, 't-alpha', c1, 100);
  assert.deepEqual(after.map(x => x.cursor), [c2]);
  assert.equal(after[0].ref_id, 'r2');
  await db.close();
});

test('snapshot / evaluation / decision round-trip tenant-scoped', async () => {
  const db = await openDb();
  await migrate(db);
  await repos.ensureTenant(db, 't-alpha', 'Alpha');
  await repos.ensureTenant(db, 't-beta', 'Beta');

  const snapshot: DecisionSnapshot = {
    snapshot_id: 'snap-1', tenant_id: 't-alpha', run_id: 'run-1', event_id: 'ev-1', boundary: 'pre_tool',
    as_of: iso(), cutoff_seq: 1, extractor_version: 'test', task_goal: null,
    candidate_action: { tool: 'payments.execute', operation_id: 'op-1', impact: 'payment', args_summary: { amount_usd: 8420 } },
    history: [], evidence: [], facts: { amount_usd: 8420, approval_limit_usd: 25000, approval_status: 'approved', tool_impact: 'payment', tool_known: true },
    required_evidence: [], missing_evidence: [], stale_evidence: [],
    judge_view: { state: 'x', token_estimate: 1, truncated: false },
  };
  await repos.insertSnapshot(db, snapshot);
  assert.deepEqual(await repos.getSnapshot(db, 't-alpha', 'snap-1'), snapshot);
  assert.equal(await repos.getSnapshot(db, 't-beta', 'snap-1'), null);

  const evaluation: EvaluationRecord = {
    evaluation_id: 'eval-1', tenant_id: 't-alpha', event_id: 'ev-1', snapshot_id: 'snap-1', kind: 'realtime',
    rubric_id: 'ap-runtime-semantic:v1', question_ids: ['payee_relation'], required_question_ids: ['payee_relation'],
    judge_source: 'kev-local:x', served_model: null, request_hash: sha256('r'), client_request_id: 'req-1',
    vendor_request_id: null, status: 'ok', http_status: 200, attempts: 1, judge_http_rtt_ms: 12, vendor_latency_ms: null,
    usage: { input_tokens: 10, output_tokens: 5 }, billing: 'local_compute', signals: {}, errors: [],
    started_at: iso(), finished_at: iso(),
  };
  await repos.insertEvaluation(db, evaluation);
  assert.deepEqual(await repos.getEvaluation(db, 't-alpha', 'eval-1'), evaluation);
  assert.equal(await repos.getEvaluation(db, 't-beta', 'eval-1'), null);

  const decision = {
    decision_id: 'dec-1', tenant_id: 't-alpha', event_id: 'ev-1', evaluation_id: 'eval-1', snapshot_id: 'snap-1',
    policy_version: 'policy-a1', provenance: { source_mode: 'live_sandbox_shadow', judge_source: null, tool_environment: 'sandbox', enforcement_mode: 'shadow' },
    recommended: 'NO_CONFIGURED_RISK', decided_by: 'default', would_have: 'allow', enforced_action: null, reasons: [],
    rule_results: [], semantic: { calibrated: false, hits: [] }, coverage_gaps: [], timings: { ingest_to_signal_ms: null, snapshot_ms: null, rules_ms: null, judge_http_rtt_ms: null, policy_ms: null }, created_at: iso(),
  } as PolicyDecision;
  await repos.insertDecision(db, decision, null);
  assert.deepEqual(await repos.getDecision(db, 't-alpha', 'dec-1'), decision);
  assert.deepEqual(await repos.listDecisionsForEvent(db, 't-alpha', 'ev-1').then(x => x.map(d => d.decision_id)), ['dec-1']);
  assert.equal(await repos.getDecision(db, 't-beta', 'dec-1'), null);
  await db.close();
});

test('api keys are stored hashed; findApiKey resolves by hash only', async () => {
  const db = await openDb();
  await migrate(db);
  await repos.ensureTenant(db, 't-alpha', 'Alpha');
  await repos.createApiKey(db, 't-alpha', 'ingest', 'lbl', 'secret-key-123');
  assert.deepEqual(await repos.findApiKey(db, 'secret-key-123'), { tenant_id: 't-alpha', role: 'ingest' });
  assert.equal(await repos.findApiKey(db, 'wrong'), null);
  const stored = await db.query<{ key_hash: string }>(`SELECT key_hash FROM api_keys`);
  assert.notEqual(stored.rows[0].key_hash, 'secret-key-123');
  assert.match(stored.rows[0].key_hash, /^sha256:[0-9a-f]{64}$/);
  await db.close();
});

test('runs are upserted and listed per tenant', async () => {
  const db = await openDb();
  await migrate(db);
  await repos.ensureTenant(db, 't-alpha', 'Alpha');
  await repos.upsertRun(db, { tenant_id: 't-alpha', run_id: 'run-1', driver: 'scripted_driver', scenario: 'S1', provenance: { source: 'sdk' } });
  await repos.finishRun(db, 't-alpha', 'run-1', 'finished');
  const runs = await repos.listRuns(db, 't-alpha', 10);
  assert.equal(runs.length, 1);
  assert.equal((runs[0] as { run_id: string }).run_id, 'run-1');
  assert.equal((runs[0] as { status: string }).status, 'finished');
  assert.deepEqual(await repos.listRuns(db, 't-beta', 10), []);
  await db.close();
});
