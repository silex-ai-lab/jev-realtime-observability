// Review queue and label routes (docs/CONTRACTS.md §10). Resolving a review records a human's labels and
// closes the task; it never releases, executes or re-issues a held action (plan D3).
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as repos from '../storage/repos.ts';
import * as reviews from '../storage/reviews.ts';
import { MANIFEST, RUBRIC } from '../state/index.ts';
import { sampleForReview } from '../labeling/index.ts';
import type { Queryable } from '../storage/db.ts';
import type { WireQuestion } from '../../contracts/judge.ts';
import { LabelInput, ReviewResolve, labelValueError, type ReviewStatus, type ReviewTask } from '../../contracts/labels.ts';
import { HttpError, readJson, send, type AuthFn } from './http.ts';
import type { ApiDeps } from './index.ts';

const STATUSES: ReadonlySet<string> = new Set(['open', 'resolved_allow', 'resolved_deny', 'expired']);
const ID = '([A-Za-z0-9._:~\\-]+)';
const reviewMatch = new RegExp(`^/v1/reviews/${ID}$`), resolveMatch = new RegExp(`^/v1/reviews/${ID}/resolve$`);

function checkValue(questionId: string, value: unknown): void {
  const q = Object.hasOwn(RUBRIC.questions, questionId) ? RUBRIC.questions[questionId] : undefined;
  if (!q) throw new HttpError(400, 'unknown_question', `unknown question ${questionId}`);
  const err = labelValueError(q, value);
  if (err) throw new HttpError(400, 'bad_value', `${questionId}: ${err}`);
}

/** The questions a review task may answer (plan batch 2 D4): those of the evaluation fixed in the task body when it
 *  asked any, else the rubric questions whose manifest boundaries include the frozen snapshot's boundary (the whole
 *  rubric if the snapshot is missing). The body's evaluation and the snapshot never change, so the set is the same at
 *  GET and resolve; a diagnostic evaluation that arrives later judged a different snapshot and is ignored. */
async function reviewQuestions(q: Queryable, tenantId: string, t: ReviewTask): Promise<Record<string, WireQuestion>> {
  const ev = t.body.evaluation_id ? await repos.getEvaluation(q, tenantId, t.body.evaluation_id) : null;
  let ids = ev && ev.question_ids.length ? ev.question_ids : null;
  if (!ids) {
    const snap = await repos.getSnapshot(q, tenantId, t.body.snapshot_id);
    ids = Object.keys(RUBRIC.questions).filter(id => !snap || (MANIFEST.questions[id]?.boundaries.includes(snap.boundary) ?? true));
  }
  return Object.fromEntries(ids.filter(id => Object.hasOwn(RUBRIC.questions, id)).map(id => [id, RUBRIC.questions[id]]));
}

/** Returns true when the request was one of this module's routes. */
export async function handle(d: ApiDeps, auth: AuthFn, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname, m = req.method ?? 'GET';

  if (m === 'GET' && p === '/v1/reviews') {
    const a = await auth(req, ['reader', 'admin']);
    const s = url.searchParams.get('status') ?? 'open';
    if (s !== 'all' && !STATUSES.has(s)) throw new HttpError(400, 'bad_status', 'status must be open, resolved_allow, resolved_deny, expired or all');
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 50) || 50));
    send(res, 200, { reviews: await reviews.listReviewTasks(d.db, a.tenant_id, s === 'all' ? null : s as ReviewStatus, limit) });
    return true;
  }
  const one = reviewMatch.exec(p);
  if (m === 'GET' && one) {
    const a = await auth(req, ['reader', 'admin']);
    const t = await reviews.getReviewTask(d.db, a.tenant_id, one[1]);
    if (!t) throw new HttpError(404, 'not_found', 'review not found');
    send(res, 200, { review: t, questions: await reviewQuestions(d.db, a.tenant_id, t), snapshot: await repos.getSnapshot(d.db, a.tenant_id, t.body.snapshot_id),
      evaluation: t.body.evaluation_id ? await repos.getEvaluation(d.db, a.tenant_id, t.body.evaluation_id) : null,
      decision: await repos.getDecision(d.db, a.tenant_id, t.decision_id) });
    return true;
  }
  if (m === 'POST' && p === '/v1/reviews/sample') {
    const a = await auth(req, ['admin']);
    const body = await readJson(req);
    const raw = body && typeof body === 'object' ? (body as { budget?: unknown }).budget : undefined;
    if (raw !== undefined && (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 100))
      throw new HttpError(400, 'bad_budget', 'budget must be an integer from 1 to 100');
    const opened = await sampleForReview(d.db, a.tenant_id, (raw as number | undefined) ?? 20);
    if (opened.length) d.notify();
    send(res, 200, { opened });
    return true;
  }
  const resolve = resolveMatch.exec(p);
  if (m === 'POST' && resolve) {
    const a = await auth(req, ['admin']);
    const parsed = ReviewResolve.safeParse(await readJson(req));
    if (!parsed.success) throw new HttpError(400, 'bad_request', parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    const { outcome, answers } = parsed.data;
    const out = await d.db.tx(async q => {
      const t = await reviews.getReviewTask(q, a.tenant_id, resolve[1], true);
      if (!t) throw new HttpError(404, 'not_found', 'review not found');
      if (t.status !== 'open') throw new HttpError(409, 'already_resolved', `review is ${t.status}`);
      const allowed = new Set(Object.keys(await reviewQuestions(q, a.tenant_id, t)));
      for (const [qid, v] of Object.entries(answers)) {
        if (!allowed.has(qid)) throw new HttpError(400, 'unknown_question', `${qid} was not asked for this decision`);
        checkValue(qid, v);
      }
      const labels = [];
      for (const [qid, v] of Object.entries(answers))
        labels.push(await reviews.insertLabel(q, { tenant_id: a.tenant_id, ref: t.body.snapshot_id, question_id: qid, value: v as boolean | string,
          evidence_class: 'human_reviewed', source: `review:${t.review_id}` }));
      const at = new Date().toISOString();
      const body = { ...t.body, resolution: { outcome, actor: 'admin-key', at, label_ids: labels.map(l => l.label_id) } };
      if (!await reviews.closeReviewTask(q, a.tenant_id, t.review_id, outcome === 'allow' ? 'resolved_allow' : 'resolved_deny', body))
        throw new HttpError(409, 'already_resolved', 'review was resolved concurrently');
      await repos.audit(q, a.tenant_id, 'admin-key', 'review_resolved', { review_id: t.review_id, decision_id: t.decision_id, outcome, label_ids: body.resolution.label_ids });
      await repos.appendOutbox(q, { tenant_id: a.tenant_id, kind: 'review', ref_id: t.review_id, run_id: t.body.run_id,
        payload: { review_id: t.review_id, decision_id: t.decision_id, status: outcome === 'allow' ? 'resolved_allow' : 'resolved_deny' } });
      return { review_id: t.review_id, status: outcome === 'allow' ? 'resolved_allow' : 'resolved_deny', labels };
    });
    d.notify();
    send(res, 200, out);
    return true;
  }

  if (m === 'POST' && p === '/v1/labels') {
    const a = await auth(req, ['admin']);
    const parsed = LabelInput.safeParse(await readJson(req));
    if (!parsed.success) throw new HttpError(400, 'bad_request', parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    const l = parsed.data;
    checkValue(l.question_id, l.value);
    const known = (await repos.getEvaluation(d.db, a.tenant_id, l.ref)) ?? (await repos.getSnapshot(d.db, a.tenant_id, l.ref));
    if (!known) throw new HttpError(404, 'not_found', 'ref is not an evaluation or snapshot of this tenant');
    const label = await d.db.tx(async q => {
      const row = await reviews.insertLabel(q, { tenant_id: a.tenant_id, ref: l.ref, question_id: l.question_id, value: l.value as boolean | string, evidence_class: l.evidence_class, source: l.source });
      await repos.audit(q, a.tenant_id, 'admin-key', 'label_created', { label_id: row.label_id, ref: l.ref, question_id: l.question_id, evidence_class: l.evidence_class });
      return row;
    });
    send(res, 201, { label });
    return true;
  }
  if (m === 'GET' && p === '/v1/labels') {
    const a = await auth(req, ['reader', 'admin']);
    send(res, 200, { labels: await reviews.listLabels(d.db, a.tenant_id, { ref: url.searchParams.get('ref'), question_id: url.searchParams.get('question_id') }, 500) });
    return true;
  }
  return false;
}
