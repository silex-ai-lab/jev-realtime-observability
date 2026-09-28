// T1 (deepseek). Repositories over the core schema (0001_init.sql).
// Every function takes a Queryable so callers can compose them inside one db.tx().
import type { Queryable } from './db.ts';
import type { StoredEvent } from '../../contracts/events.ts';
import type { DecisionSnapshot } from '../../contracts/snapshot.ts';
import type { EvaluationRecord } from '../../contracts/judge.ts';
import type { PolicyDecision } from '../../contracts/decision.ts';
import type { StreamKind, StreamRecord } from '../../contracts/stream.ts';
import type { JudgeLedgerRow } from '../judges/index.ts';
import { sha256 } from '../../contracts/canonical.ts';

export type JobKind = 'realtime' | 'diagnostic' | 'model_reeval';
export interface Job { job_id: string; tenant_id: string; event_id: string; kind: JobKind; attempts: number; not_after: string; created_at: string }

const iso = (v: unknown): string | null => (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)));

// ---- tenants / keys ----
export async function ensureTenant(q: Queryable, tenantId: string, name: string): Promise<void> {
  await q.query(`INSERT INTO tenants (tenant_id, name) VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING`, [tenantId, name]);
}

/** Stores sha256(key); returns nothing that contains the key. */
export async function createApiKey(q: Queryable, tenantId: string, role: 'ingest' | 'reader' | 'gateway' | 'admin', label: string, key: string): Promise<void> {
  await q.query(`INSERT INTO api_keys (key_hash, tenant_id, role, label) VALUES ($1, $2, $3, $4) ON CONFLICT (key_hash) DO NOTHING`, [sha256(key), tenantId, role, label]);
}

export async function findApiKey(q: Queryable, key: string): Promise<{ tenant_id: string; role: string } | null> {
  const r = await q.query<{ tenant_id: string; role: string }>(`SELECT tenant_id, role FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`, [sha256(key)]);
  return r.rows[0] ?? null;
}

// ---- runs ----
export async function upsertRun(q: Queryable, r: { tenant_id: string; run_id: string; driver: string; scenario: string | null; provenance: object }): Promise<void> {
  await q.query(
    `INSERT INTO runs (tenant_id, run_id, driver, scenario, provenance) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, run_id) DO UPDATE SET driver = EXCLUDED.driver, scenario = EXCLUDED.scenario, provenance = EXCLUDED.provenance`,
    [r.tenant_id, r.run_id, r.driver, r.scenario, JSON.stringify(r.provenance)],
  );
}

export async function finishRun(q: Queryable, tenantId: string, runId: string, status: 'finished' | 'failed' | 'stopped'): Promise<void> {
  await q.query(`UPDATE runs SET status = $3, finished_at = now() WHERE tenant_id = $1 AND run_id = $2`, [tenantId, runId, status]);
}

export async function listRuns(q: Queryable, tenantId: string, limit: number, beforeStartedAt?: string): Promise<object[]> {
  const params: unknown[] = [tenantId];
  let sql = `SELECT tenant_id, run_id, driver, scenario, provenance, status, started_at, finished_at FROM runs WHERE tenant_id = $1`;
  if (beforeStartedAt) { params.push(beforeStartedAt); sql += ` AND started_at < $${params.length}`; }
  params.push(limit);
  sql += ` ORDER BY started_at DESC LIMIT $${params.length}`;
  const r = await q.query<{ tenant_id: string; run_id: string; driver: string; scenario: string | null; provenance: unknown; status: string; started_at: unknown; finished_at: unknown }>(sql, params);
  return r.rows.map(x => ({ tenant_id: x.tenant_id, run_id: x.run_id, driver: x.driver, scenario: x.scenario, provenance: x.provenance, status: x.status, started_at: iso(x.started_at), finished_at: iso(x.finished_at) }));
}

// ---- events + jobs (same transaction, RFC §9.1) ----
/**
 * Inserts the event and, if job is given, its evaluation job.
 * 'duplicate': same (tenant, event_id) or same (tenant, source_event_id) with the same content_digest → no new job.
 * 'conflict' : same id with a different content_digest → nothing written (caller audits and returns 409).
 */
export async function insertEventWithJob(q: Queryable, ev: StoredEvent, contentDigest: string,
  job: { kind: JobKind; priority: number; not_after: string } | null): Promise<'inserted' | 'duplicate' | 'conflict'> {
  const byId = await q.query<{ content_digest: string }>(`SELECT content_digest FROM events WHERE tenant_id = $1 AND event_id = $2`, [ev.tenant_id, ev.event_id]);
  if (byId.rows.length) return byId.rows[0].content_digest === contentDigest ? 'duplicate' : 'conflict';

  if (ev.source_event_id) {
    const bySource = await q.query<{ content_digest: string }>(`SELECT content_digest FROM events WHERE tenant_id = $1 AND source_event_id = $2`, [ev.tenant_id, ev.source_event_id]);
    if (bySource.rows.length) return bySource.rows[0].content_digest === contentDigest ? 'duplicate' : 'conflict';
  }

  await q.query(
    `INSERT INTO events (tenant_id, event_id, run_id, boundary, producer_id, producer_seq, source_event_id, occurred_at, received_at, ingest_path, content_digest, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [ev.tenant_id, ev.event_id, ev.run_id, ev.boundary, ev.producer_id, ev.producer_seq, ev.source_event_id ?? null,
      ev.occurred_at, ev.received_at, ev.ingest_path, contentDigest, JSON.stringify(ev)],
  );
  if (job) {
    await q.query(`INSERT INTO evaluation_jobs (tenant_id, event_id, kind, priority, not_after) VALUES ($1, $2, $3, $4, $5)`,
      [ev.tenant_id, ev.event_id, job.kind, job.priority, job.not_after]);
  }
  return 'inserted';
}

export async function getEvent(q: Queryable, tenantId: string, eventId: string): Promise<StoredEvent | null> {
  const r = await q.query<{ body: unknown }>(`SELECT body FROM events WHERE tenant_id = $1 AND event_id = $2`, [tenantId, eventId]);
  return r.rows[0] ? (r.rows[0].body as StoredEvent) : null;
}

/** The most recent `limit` events of a run received at or before `upToReceivedAt`, returned oldest first. */
export async function listRunEvents(q: Queryable, tenantId: string, runId: string, upToReceivedAt: string | null, limit: number): Promise<StoredEvent[]> {
  const params: unknown[] = [tenantId, runId];
  let sql = `SELECT body FROM events WHERE tenant_id = $1 AND run_id = $2`;
  if (upToReceivedAt) { params.push(upToReceivedAt); sql += ` AND received_at <= $${params.length}`; }
  params.push(limit);
  sql += ` ORDER BY received_at DESC, producer_seq DESC LIMIT $${params.length}`;
  const r = await q.query<{ body: unknown }>(sql, params);
  return r.rows.map(x => x.body as StoredEvent).reverse();
}

/** Leases the highest-priority ready job (status queued, or leased with lease_until < now). Atomic. */
export async function leaseJob(q: Queryable, leaseMs: number): Promise<Job | null> {
  const r = await q.query<{ job_id: string; tenant_id: string; event_id: string; kind: string; attempts: number; not_after: unknown; created_at: unknown }>(
    `WITH job AS (
       SELECT job_id FROM evaluation_jobs
       WHERE (status = 'queued' OR (status = 'leased' AND lease_until < now()))
         AND not_after > now()
       ORDER BY priority DESC, job_id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE evaluation_jobs e
     SET status = 'leased', lease_until = now() + ($1::int * interval '1 millisecond'), attempts = attempts + 1
     FROM job
     WHERE e.job_id = job.job_id
     RETURNING e.job_id::text AS job_id, e.tenant_id, e.event_id, e.kind, e.attempts, e.not_after, e.created_at`,
    [leaseMs],
  );
  const x = r.rows[0];
  if (!x) return null;
  return { job_id: x.job_id, tenant_id: x.tenant_id, event_id: x.event_id, kind: x.kind as JobKind, attempts: x.attempts, not_after: iso(x.not_after)!, created_at: iso(x.created_at)! };
}

export async function completeJob(q: Queryable, jobId: string): Promise<void> {
  await q.query(`UPDATE evaluation_jobs SET status = 'done', finished_at = now() WHERE job_id = $1`, [jobId]);
}

export async function expireJob(q: Queryable, jobId: string, reason: string): Promise<void> {
  await q.query(`UPDATE evaluation_jobs SET status = 'expired', finished_at = now(), last_error = $2 WHERE job_id = $1`, [jobId, reason]);
}

export async function failJob(q: Queryable, jobId: string, error: string, retry: boolean): Promise<void> {
  if (retry) await q.query(`UPDATE evaluation_jobs SET status = 'queued', lease_until = NULL, last_error = $2 WHERE job_id = $1`, [jobId, error]);
  else await q.query(`UPDATE evaluation_jobs SET status = 'failed', finished_at = now(), lease_until = NULL, last_error = $2 WHERE job_id = $1`, [jobId, error]);
}

export async function enqueueJob(q: Queryable, tenantId: string, eventId: string, kind: JobKind, priority: number, notAfter: string): Promise<boolean> {
  const r = await q.query(
    `INSERT INTO evaluation_jobs (tenant_id, event_id, kind, priority, not_after) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, event_id, kind) DO NOTHING RETURNING job_id`,
    [tenantId, eventId, kind, priority, notAfter],
  );
  return r.rows.length > 0;
}

// ---- evaluation records (append-only) ----
export async function insertSnapshot(q: Queryable, s: DecisionSnapshot): Promise<void> {
  await q.query(`INSERT INTO snapshots (tenant_id, snapshot_id, event_id, revision, body) VALUES ($1, $2, $3, 1, $4)`,
    [s.tenant_id, s.snapshot_id, s.event_id, JSON.stringify(s)]);
}

export async function getSnapshot(q: Queryable, tenantId: string, snapshotId: string): Promise<DecisionSnapshot | null> {
  const r = await q.query<{ body: unknown }>(`SELECT body FROM snapshots WHERE tenant_id = $1 AND snapshot_id = $2`, [tenantId, snapshotId]);
  return r.rows[0] ? (r.rows[0].body as DecisionSnapshot) : null;
}

/** Inserts the evaluation and one signals row per signal. */
export async function insertEvaluation(q: Queryable, e: EvaluationRecord): Promise<void> {
  await q.query(
    `INSERT INTO evaluations (tenant_id, evaluation_id, event_id, snapshot_id, kind, status, judge_source, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.tenant_id, e.evaluation_id, e.event_id, e.snapshot_id, e.kind, e.status, e.judge_source, JSON.stringify(e)],
  );
  for (const [questionId, sig] of Object.entries(e.signals)) {
    await q.query(`INSERT INTO signals (tenant_id, evaluation_id, question_id, body) VALUES ($1, $2, $3, $4)`,
      [e.tenant_id, e.evaluation_id, questionId, JSON.stringify(sig)]);
  }
}

export async function getEvaluation(q: Queryable, tenantId: string, evaluationId: string): Promise<EvaluationRecord | null> {
  const r = await q.query<{ body: unknown }>(`SELECT body FROM evaluations WHERE tenant_id = $1 AND evaluation_id = $2`, [tenantId, evaluationId]);
  return r.rows[0] ? (r.rows[0].body as EvaluationRecord) : null;
}

/** Evaluations for one event (realtime and diagnostic), oldest first. Tenant-scoped. (Added by planner for the run timeline, CONTRACTS §5.) */
export async function listEvaluationsForEvent(q: Queryable, tenantId: string, eventId: string): Promise<EvaluationRecord[]> {
  const r = await q.query<{ body: unknown }>(`SELECT body FROM evaluations WHERE tenant_id = $1 AND event_id = $2 ORDER BY created_at, evaluation_id`, [tenantId, eventId]);
  return r.rows.map(x => x.body as EvaluationRecord);
}

export async function insertJudgeCall(q: Queryable, row: JudgeLedgerRow): Promise<void> {
  await q.query(
    `INSERT INTO judge_calls (tenant_id, evaluation_id, caller, client_request_id, request_hash, judge_source, status, http_status, rtt_ms, input_tokens, output_tokens, billing)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [row.tenant_id, row.evaluation_id, row.caller, row.client_request_id, row.request_hash, row.judge_source, row.status,
      row.http_status, row.rtt_ms, row.input_tokens, row.output_tokens, row.billing],
  );
}

export async function countJudgeCalls(q: Queryable, tenantId: string, filter?: { caller?: string; since?: string }): Promise<number> {
  const params: unknown[] = [tenantId];
  let sql = `SELECT count(*)::int AS count FROM judge_calls WHERE tenant_id = $1`;
  if (filter?.caller) { params.push(filter.caller); sql += ` AND caller = $${params.length}`; }
  if (filter?.since) { params.push(filter.since); sql += ` AND at >= $${params.length}`; }
  const r = await q.query<{ count: number }>(sql, params);
  return r.rows[0]?.count ?? 0;
}

export async function insertDecision(q: Queryable, d: PolicyDecision, replayOf: string | null): Promise<void> {
  await q.query(
    `INSERT INTO decisions (tenant_id, decision_id, event_id, evaluation_id, policy_version, recommended, replay_of, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [d.tenant_id, d.decision_id, d.event_id, d.evaluation_id, d.policy_version, d.recommended, replayOf, JSON.stringify(d)],
  );
}

export async function getDecision(q: Queryable, tenantId: string, decisionId: string): Promise<PolicyDecision | null> {
  const r = await q.query<{ body: unknown }>(`SELECT body FROM decisions WHERE tenant_id = $1 AND decision_id = $2`, [tenantId, decisionId]);
  return r.rows[0] ? (r.rows[0].body as PolicyDecision) : null;
}

export async function listDecisionsForEvent(q: Queryable, tenantId: string, eventId: string): Promise<PolicyDecision[]> {
  const r = await q.query<{ body: unknown }>(`SELECT body FROM decisions WHERE tenant_id = $1 AND event_id = $2 ORDER BY created_at ASC`, [tenantId, eventId]);
  return r.rows.map(x => x.body as PolicyDecision);
}

// ---- outbox (SSE source of truth) ----
export async function appendOutbox(q: Queryable, r: { tenant_id: string; kind: StreamKind; ref_id: string; run_id: string | null; payload: object }): Promise<string> {
  const res = await q.query<{ cursor: string }>(
    `INSERT INTO outbox (tenant_id, kind, ref_id, run_id, payload) VALUES ($1, $2, $3, $4, $5) RETURNING cursor::text AS cursor`,
    [r.tenant_id, r.kind, r.ref_id, r.run_id, JSON.stringify(r.payload)],
  );
  return res.rows[0].cursor;
}

/** Records with cursor > afterCursor for this tenant only, ascending, at most limit. */
export async function readOutbox(q: Queryable, tenantId: string, afterCursor: string, limit: number): Promise<StreamRecord[]> {
  const r = await q.query<{ cursor: string; kind: string; ref_id: string; run_id: string | null; payload: unknown; at: unknown }>(
    `SELECT cursor::text AS cursor, kind, ref_id, run_id, payload, at FROM outbox WHERE tenant_id = $1 AND cursor > $2::bigint ORDER BY cursor ASC LIMIT $3`,
    [tenantId, afterCursor, limit],
  );
  return r.rows.map(x => ({ cursor: x.cursor, kind: x.kind as StreamKind, ref_id: x.ref_id, run_id: x.run_id, payload: x.payload as Record<string, unknown>, at: iso(x.at)! }));
}

// ---- policies / audit ----
export async function insertPolicyVersion(q: Queryable, p: { policy_version: string; tenant_id: string; base_version: string | null; status: string; body: object; actor: string }): Promise<void> {
  await q.query(`INSERT INTO policy_versions (policy_version, tenant_id, base_version, status, body, actor) VALUES ($1, $2, $3, $4, $5, $6)`,
    [p.policy_version, p.tenant_id, p.base_version, p.status, JSON.stringify(p.body), p.actor]);
}

export async function getActivePolicy(q: Queryable, tenantId: string): Promise<{ policy_version: string; body: object } | null> {
  const r = await q.query<{ policy_version: string; body: unknown }>(
    `SELECT policy_version, body FROM policy_versions WHERE tenant_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`, [tenantId]);
  return r.rows[0] ? { policy_version: r.rows[0].policy_version, body: r.rows[0].body as object } : null;
}

export async function audit(q: Queryable, tenantId: string, actor: string, action: string, detail: object): Promise<void> {
  await q.query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, $3, $4)`, [tenantId, actor, action, JSON.stringify(detail)]);
}
