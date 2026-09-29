// Review tasks and labels (docs/CONTRACTS.md §10). Every query is tenant-scoped.
import { randomUUID } from 'node:crypto';
import type { Queryable } from './db.ts';
import type { PolicyDecision } from '../../contracts/decision.ts';
import type { EvidenceClass, Label, ReviewStatus, ReviewTask, SampleReason } from '../../contracts/labels.ts';

/** Which original decisions open a review task (plan D2): HOLD and REVIEW always; UNKNOWN only on the
 *  preflight path, where the action is actually held. Replays never call this. */
export function needsReview(recommended: string, path: 'worker' | 'preflight'): boolean {
  return recommended === 'HOLD' || recommended === 'REVIEW' || (path === 'preflight' && recommended === 'UNKNOWN');
}

/** Opens a review task for the decision inside the caller's transaction. Idempotent per decision.
 *  Returns the new review id, or null when the decision needs none or already has one. */
export async function openReviewTask(q: Queryable, d: PolicyDecision, ctx: { path: 'worker' | 'preflight'; run_id: string | null; tool: string | null }): Promise<string | null> {
  if (!needsReview(d.recommended, ctx.path)) return null;
  const reviewId = `rev-${randomUUID()}`;
  const body: ReviewTask['body'] = { path: ctx.path, event_id: d.event_id, run_id: ctx.run_id, snapshot_id: d.snapshot_id, evaluation_id: d.evaluation_id,
    recommended: d.recommended, decided_by: d.decided_by, tool: ctx.tool, reasons: d.reasons };
  const r = await q.query<{ review_id: string }>(
    `INSERT INTO review_tasks (tenant_id, review_id, decision_id, status, body) VALUES ($1, $2, $3, 'open', $4)
     ON CONFLICT (tenant_id, decision_id) DO NOTHING RETURNING review_id`,
    [d.tenant_id, reviewId, d.decision_id, JSON.stringify(body)]);
  return r.rows[0]?.review_id ?? null;
}

/** Opens a sampler task (T7) for any original decision, recording why and which evaluation caused it, so the
 *  panel and resolve use that evaluation's questions. Idempotent per decision like openReviewTask: returns null
 *  when the decision already has a task, open or resolved. */
export async function openSampledReviewTask(q: Queryable, d: PolicyDecision, ctx: { run_id: string | null; tool: string | null },
  reason: SampleReason, evaluationId: string): Promise<string | null> {
  const reviewId = `rev-${randomUUID()}`;
  const body: ReviewTask['body'] = { path: 'sampler', event_id: d.event_id, run_id: ctx.run_id, snapshot_id: d.snapshot_id, evaluation_id: evaluationId,
    recommended: d.recommended, decided_by: d.decided_by, tool: ctx.tool, reasons: d.reasons, sample_reason: reason };
  const r = await q.query<{ review_id: string }>(
    `INSERT INTO review_tasks (tenant_id, review_id, decision_id, status, body) VALUES ($1, $2, $3, 'open', $4)
     ON CONFLICT (tenant_id, decision_id) DO NOTHING RETURNING review_id`,
    [d.tenant_id, reviewId, d.decision_id, JSON.stringify(body)]);
  return r.rows[0]?.review_id ?? null;
}

const taskOf = (x: { tenant_id: string; review_id: string; decision_id: string; status: string; body: unknown; created_at: unknown }): ReviewTask =>
  ({ review_id: x.review_id, tenant_id: x.tenant_id, decision_id: x.decision_id, status: x.status as ReviewStatus,
    created_at: new Date(x.created_at as string).toISOString(), body: x.body as ReviewTask['body'] });

export async function listReviewTasks(q: Queryable, tenantId: string, status: ReviewStatus | null, limit: number): Promise<ReviewTask[]> {
  const r = await q.query<Parameters<typeof taskOf>[0]>(
    `SELECT tenant_id, review_id, decision_id, status, body, created_at FROM review_tasks
     WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC, review_id LIMIT $3`, [tenantId, status, limit]);
  return r.rows.map(taskOf);
}

export async function getReviewTask(q: Queryable, tenantId: string, reviewId: string, forUpdate = false): Promise<ReviewTask | null> {
  const r = await q.query<Parameters<typeof taskOf>[0]>(
    `SELECT tenant_id, review_id, decision_id, status, body, created_at FROM review_tasks WHERE tenant_id = $1 AND review_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [tenantId, reviewId]);
  return r.rows[0] ? taskOf(r.rows[0]) : null;
}

export async function closeReviewTask(q: Queryable, tenantId: string, reviewId: string, status: 'resolved_allow' | 'resolved_deny', body: ReviewTask['body']): Promise<boolean> {
  const r = await q.query(`UPDATE review_tasks SET status = $3, body = $4 WHERE tenant_id = $1 AND review_id = $2 AND status = 'open' RETURNING review_id`,
    [tenantId, reviewId, status, JSON.stringify(body)]);
  return r.rows.length === 1;
}

export async function insertLabel(q: Queryable, l: { tenant_id: string; ref: string; question_id: string; value: boolean | string; evidence_class: EvidenceClass; source: string }): Promise<Label> {
  const labelId = `lbl-${randomUUID()}`;
  const r = await q.query<{ created_at: unknown }>(
    `INSERT INTO labels (label_id, tenant_id, ref, question_id, value, evidence_class, source) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING created_at`,
    [labelId, l.tenant_id, l.ref, l.question_id, JSON.stringify(l.value), l.evidence_class, l.source]);
  return { label_id: labelId, ...l, created_at: new Date(r.rows[0].created_at as string).toISOString() };
}

export async function listLabels(q: Queryable, tenantId: string, f: { ref: string | null; question_id: string | null }, limit: number): Promise<Label[]> {
  const r = await q.query<{ label_id: string; tenant_id: string; ref: string; question_id: string; value: unknown; evidence_class: EvidenceClass; source: string; created_at: unknown }>(
    `SELECT label_id, tenant_id, ref, question_id, value, evidence_class, source, created_at FROM labels
     WHERE tenant_id = $1 AND ($2::text IS NULL OR ref = $2) AND ($3::text IS NULL OR question_id = $3)
     ORDER BY created_at DESC, label_id LIMIT $4`, [tenantId, f.ref, f.question_id, limit]);
  return r.rows.map(x => ({ ...x, value: x.value as boolean | string, created_at: new Date(x.created_at as string).toISOString() }));
}
