// T1 (deepseek) implements. Repositories over the core schema (0001_init.sql).
// Every function takes a Queryable so callers can compose them inside one db.tx().
import type { Queryable } from './db.ts';
import type { StoredEvent } from '../../contracts/events.ts';
import type { DecisionSnapshot } from '../../contracts/snapshot.ts';
import type { EvaluationRecord } from '../../contracts/judge.ts';
import type { PolicyDecision } from '../../contracts/decision.ts';
import type { StreamKind, StreamRecord } from '../../contracts/stream.ts';
import type { JudgeLedgerRow } from '../judges/index.ts';

export type JobKind = 'realtime' | 'diagnostic' | 'model_reeval';
export interface Job { job_id: string; tenant_id: string; event_id: string; kind: JobKind; attempts: number; not_after: string; created_at: string }

// ---- tenants / keys ----
export async function ensureTenant(q: Queryable, tenantId: string, name: string): Promise<void> { throw new Error('T1'); }
/** Stores sha256(key); returns nothing that contains the key. */
export async function createApiKey(q: Queryable, tenantId: string, role: 'ingest' | 'reader' | 'gateway' | 'admin', label: string, key: string): Promise<void> { throw new Error('T1'); }
export async function findApiKey(q: Queryable, key: string): Promise<{ tenant_id: string; role: string } | null> { throw new Error('T1'); }

// ---- runs ----
export async function upsertRun(q: Queryable, r: { tenant_id: string; run_id: string; driver: string; scenario: string | null; provenance: object }): Promise<void> { throw new Error('T1'); }
export async function finishRun(q: Queryable, tenantId: string, runId: string, status: 'finished' | 'failed' | 'stopped'): Promise<void> { throw new Error('T1'); }
export async function listRuns(q: Queryable, tenantId: string, limit: number, beforeStartedAt?: string): Promise<object[]> { throw new Error('T1'); }

// ---- events + jobs (same transaction, RFC §9.1) ----
/**
 * Inserts the event and, if job is given, its evaluation job.
 * 'duplicate': same (tenant, event_id) or same (tenant, source_event_id) with the same content_digest → no new job.
 * 'conflict' : same id with a different content_digest → nothing written (caller audits and returns 409).
 */
export async function insertEventWithJob(q: Queryable, ev: StoredEvent, contentDigest: string,
  job: { kind: JobKind; priority: number; not_after: string } | null): Promise<'inserted' | 'duplicate' | 'conflict'> { throw new Error('T1'); }
export async function getEvent(q: Queryable, tenantId: string, eventId: string): Promise<StoredEvent | null> { throw new Error('T1'); }
/** Events of a run received at or before `upToReceivedAt`, ordered by received_at, producer_seq. */
export async function listRunEvents(q: Queryable, tenantId: string, runId: string, upToReceivedAt: string | null, limit: number): Promise<StoredEvent[]> { throw new Error('T1'); }

/** Leases the highest-priority ready job (status queued, or leased with lease_until < now). Atomic. */
export async function leaseJob(q: Queryable, leaseMs: number): Promise<Job | null> { throw new Error('T1'); }
export async function completeJob(q: Queryable, jobId: string): Promise<void> { throw new Error('T1'); }
export async function expireJob(q: Queryable, jobId: string, reason: string): Promise<void> { throw new Error('T1'); }
export async function failJob(q: Queryable, jobId: string, error: string, retry: boolean): Promise<void> { throw new Error('T1'); }
export async function enqueueJob(q: Queryable, tenantId: string, eventId: string, kind: JobKind, priority: number, notAfter: string): Promise<boolean> { throw new Error('T1'); }

// ---- evaluation records (append-only) ----
export async function insertSnapshot(q: Queryable, s: DecisionSnapshot): Promise<void> { throw new Error('T1'); }
export async function getSnapshot(q: Queryable, tenantId: string, snapshotId: string): Promise<DecisionSnapshot | null> { throw new Error('T1'); }
/** Inserts the evaluation and one signals row per signal. */
export async function insertEvaluation(q: Queryable, e: EvaluationRecord): Promise<void> { throw new Error('T1'); }
export async function getEvaluation(q: Queryable, tenantId: string, evaluationId: string): Promise<EvaluationRecord | null> { throw new Error('T1'); }
export async function insertJudgeCall(q: Queryable, row: JudgeLedgerRow): Promise<void> { throw new Error('T1'); }
export async function countJudgeCalls(q: Queryable, tenantId: string, filter?: { caller?: string; since?: string }): Promise<number> { throw new Error('T1'); }
export async function insertDecision(q: Queryable, d: PolicyDecision, replayOf: string | null): Promise<void> { throw new Error('T1'); }
export async function getDecision(q: Queryable, tenantId: string, decisionId: string): Promise<PolicyDecision | null> { throw new Error('T1'); }
export async function listDecisionsForEvent(q: Queryable, tenantId: string, eventId: string): Promise<PolicyDecision[]> { throw new Error('T1'); }

// ---- outbox (SSE source of truth) ----
export async function appendOutbox(q: Queryable, r: { tenant_id: string; kind: StreamKind; ref_id: string; run_id: string | null; payload: object }): Promise<string> { throw new Error('T1'); }
/** Records with cursor > afterCursor for this tenant only, ascending, at most limit. */
export async function readOutbox(q: Queryable, tenantId: string, afterCursor: string, limit: number): Promise<StreamRecord[]> { throw new Error('T1'); }

// ---- policies / audit ----
export async function insertPolicyVersion(q: Queryable, p: { policy_version: string; tenant_id: string; base_version: string | null; status: string; body: object; actor: string }): Promise<void> { throw new Error('T1'); }
export async function getActivePolicy(q: Queryable, tenantId: string): Promise<{ policy_version: string; body: object } | null> { throw new Error('T1'); }
export async function audit(q: Queryable, tenantId: string, actor: string, action: string, detail: object): Promise<void> { throw new Error('T1'); }
