// Review queue and label routes (docs/CONTRACTS.md §10). Resolving a review records a human's labels and
// closes the task; it never releases, executes or re-issues a held action (plan D3).
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as repos from '../storage/repos.ts';
import * as reviews from '../storage/reviews.ts';
import { RUBRIC } from '../state/index.ts';
import { LabelInput, ReviewResolve, labelValueError, type ReviewStatus } from '../../contracts/labels.ts';
import { HttpError, readJson, send, type AuthFn } from './http.ts';
import type { ApiDeps } from './index.ts';

const STATUSES: ReadonlySet<string> = new Set(['open', 'resolved_allow', 'resolved_deny', 'expired']);
const ID = '([A-Za-z0-9._:~\\-]+)';
const reviewMatch = new RegExp(`^/v1/reviews/${ID}$`), resolveMatch = new RegExp(`^/v1/reviews/${ID}/resolve$`);

function checkValue(questionId: string, value: unknown): void {
  const q = RUBRIC.questions[questionId];
  if (!q) throw new HttpError(400, 'unknown_question', `unknown question ${questionId}`);
  const err = labelValueError(q, value);
  if (err) throw new HttpError(400, 'bad_value', `${questionId}: ${err}`);
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
    send(res, 200, { review: t, snapshot: await repos.getSnapshot(d.db, a.tenant_id, t.body.snapshot_id),
      evaluation: t.body.evaluation_id ? await repos.getEvaluation(d.db, a.tenant_id, t.body.evaluation_id) : null,
      decision: await repos.getDecision(d.db, a.tenant_id, t.decision_id) });
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
      // Answers must be questions this decision's judge was asked (any rubric question when it had no evaluation).
      const ev = t.body.evaluation_id ? await repos.getEvaluation(q, a.tenant_id, t.body.evaluation_id) : null;
      const allowed = new Set(ev && ev.question_ids.length ? ev.question_ids : Object.keys(RUBRIC.questions));
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
