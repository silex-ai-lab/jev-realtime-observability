// Active-learning sampler (T7; plan batch 2 D3): opens review tasks for the most informative original
// decisions that have no review task yet. Three classes in priority order, newest first within a class:
//   1. uncertain                    — a required risk question answered 0.3–0.7 by the realtime judge;
//   2. judge_flags_unruled_risk     — no rule held it, but a realtime risk answer is ≥ 0.7 (a heuristic);
//   3. cross_judge_disagreement     — two valid evaluations of the same snapshot by different served models
//                                     disagree on a risk question across 0.5.
// Only valid evidence counts: evaluations with status ok/partial and non-null raw_probability. Only the risk
// questions instruction_override / goal_deviation / sensitive_data_transfer are compared.
import type { Db, Queryable } from '../storage/db.ts';
import type { SampleReason } from '../../contracts/labels.ts';
import type { PolicyDecision } from '../../contracts/decision.ts';
import type { EvaluationRecord } from '../../contracts/judge.ts';
import * as repos from '../storage/repos.ts';
import { openSampledReviewTask } from '../storage/reviews.ts';

export interface SampledTask { review_id: string; decision_id: string; reason: SampleReason }

const RISK_QUESTIONS = ['instruction_override', 'goal_deviation', 'sensitive_data_transfer'];
const HARD_RULE_SQL = `('HOLD', 'BLOCK', 'STOP')`;   // hard-rule verdicts, a constant SQL list

interface DecRow { decision_id: string; evaluation_id: string | null; created_at: string; decision: PolicyDecision }
interface EvRow { evaluation_id: string; snapshot_id: string; created_at: string; ev: EvaluationRecord }

const prob = (ev: EvaluationRecord, qid: string): number | null =>
  ev.signals?.[qid] && typeof ev.signals[qid].raw_probability === 'number' ? (ev.signals[qid].raw_probability as number) : null;

const runOf = (ev: EvaluationRecord): string | null => ev.served_model?.run ?? null;

/** The newer of a disagreeing pair (different served-model runs, opposite sides of 0.5 on some risk question). */
function findDisagreement(es: EvRow[]): EvRow | null {
  for (let i = 0; i < es.length; i++) {
    for (let j = i + 1; j < es.length; j++) {
      const a = es[i], b = es[j];
      const ra = runOf(a.ev), rb = runOf(b.ev);
      if (!ra || !rb || ra === rb) continue;
      for (const qid of RISK_QUESTIONS) {
        const pa = prob(a.ev, qid), pb = prob(b.ev, qid);
        if (pa == null || pb == null) continue;
        if ((pa < 0.5 && pb > 0.5) || (pa > 0.5 && pb < 0.5)) return a.created_at >= b.created_at ? a : b;
      }
    }
  }
  return null;
}

// The class predicates run in SQL (N3), so a call reads only candidate rows, not the tenant's whole history.
// Task-less original decisions of the tenant, as `d`:
const OPEN_DECISIONS = `d.tenant_id = $1 AND d.replay_of IS NULL
  AND NOT EXISTS (SELECT 1 FROM review_tasks t WHERE t.tenant_id = d.tenant_id AND t.decision_id = d.decision_id)`;
// A numeric raw_probability of risk question `qid` in evaluation `e`, as float8 (null otherwise).
const P = `CASE WHEN jsonb_typeof(e.body->'signals'->qid->'raw_probability') = 'number'
  THEN (e.body->'signals'->qid->>'raw_probability')::float8 END`;
// 1. a required risk question answered 0.3–0.7 by the realtime judge.
const UNCERTAIN = `EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(e.body->'required_question_ids', '[]'::jsonb)) AS r(qid)
  WHERE qid = ANY($2::text[]) AND ${P} BETWEEN 0.3 AND 0.7)`;
// 2. no hard rule held it, but some realtime risk answer is ≥ 0.7.
const UNRULED_RISK = `NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(d.body->'rule_results', '[]'::jsonb)) AS rr(x)
    WHERE rr.x->>'verdict' IN ${HARD_RULE_SQL})
  AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS r(qid) WHERE ${P} >= 0.7)`;

async function realtimeCandidates(q: Queryable, tenantId: string, predicate: string, limit: number): Promise<DecRow[]> {
  const r = await q.query<{ decision_id: string; evaluation_id: string; created_at: string; body: PolicyDecision }>(
    `SELECT d.decision_id, d.evaluation_id, d.created_at::text AS created_at, d.body FROM decisions d
     JOIN evaluations e ON e.tenant_id = d.tenant_id AND e.evaluation_id = d.evaluation_id
     WHERE ${OPEN_DECISIONS} AND e.status IN ('ok', 'partial') AND e.body->>'kind' = 'realtime' AND ${predicate}
     ORDER BY d.created_at DESC, d.decision_id LIMIT $3`,
    [tenantId, RISK_QUESTIONS, limit]);
  return r.rows.map(x => ({ decision_id: x.decision_id, evaluation_id: x.evaluation_id, created_at: x.created_at, decision: x.body }));
}

/** Opens at most `budget` sampler tasks for the tenant in one transaction; returns what it opened. */
export async function sampleForReview(db: Db, tenantId: string, budget: number): Promise<SampledTask[]> {
  return db.tx(async q => {
    const picked: Array<{ dec: DecRow; reason: SampleReason; evaluationId: string }> = [];
    const taken = new Set<string>();
    const add = (dec: DecRow, reason: SampleReason, evaluationId: string) => {
      if (taken.has(dec.decision_id) || picked.length >= budget) return;
      taken.add(dec.decision_id);
      picked.push({ dec, reason, evaluationId });
    };

    // classes 1 and 2, newest first. At most picked.length of the first `budget` rows are already taken, so
    // `budget` rows always leave enough for the remaining slots.
    for (const d of await realtimeCandidates(q, tenantId, UNCERTAIN, budget)) add(d, 'uncertain', d.evaluation_id!);
    if (picked.length < budget)
      for (const d of await realtimeCandidates(q, tenantId, UNRULED_RISK, budget)) add(d, 'judge_flags_unruled_risk', d.evaluation_id!);

    // class 3: only snapshots with valid evaluations from at least two served-model runs are read.
    if (picked.length < budget) {
      const evQ = await q.query<{ evaluation_id: string; snapshot_id: string; created_at: string; body: EvaluationRecord }>(
        `WITH multi AS MATERIALIZED (
           SELECT snapshot_id FROM evaluations WHERE tenant_id = $1 AND status IN ('ok', 'partial')
           GROUP BY snapshot_id HAVING count(DISTINCT body->'served_model'->>'run') >= 2)
         SELECT e.evaluation_id, e.snapshot_id, e.created_at::text AS created_at, e.body FROM evaluations e
         JOIN multi m ON m.snapshot_id = e.snapshot_id
         WHERE e.tenant_id = $1 AND e.status IN ('ok', 'partial')`,
        [tenantId]);
      const bySnapshot = new Map<string, EvRow[]>();
      for (const r of evQ.rows) {
        const e: EvRow = { evaluation_id: r.evaluation_id, snapshot_id: r.snapshot_id, created_at: r.created_at, ev: r.body };
        const list = bySnapshot.get(e.snapshot_id);
        if (list) list.push(e); else bySnapshot.set(e.snapshot_id, [e]);
      }
      // One decision per snapshot: the oldest (ties: the highest id), as the pre-N3 newest-first map kept.
      const decQ = bySnapshot.size ? await q.query<{ decision_id: string; created_at: string; body: PolicyDecision }>(
        `SELECT DISTINCT ON (d.body->>'snapshot_id') d.decision_id, d.created_at::text AS created_at, d.body FROM decisions d
         WHERE ${OPEN_DECISIONS} AND d.body->>'snapshot_id' = ANY($2::text[])
         ORDER BY d.body->>'snapshot_id', d.created_at ASC, d.decision_id DESC`,
        [tenantId, [...bySnapshot.keys()]]) : { rows: [] };
      const class3: Array<{ dec: DecRow; evaluationId: string }> = [];
      for (const r of decQ.rows) {
        const dec: DecRow = { decision_id: r.decision_id, evaluation_id: null, created_at: r.created_at, decision: r.body };
        if (taken.has(dec.decision_id)) continue;
        const newer = findDisagreement(bySnapshot.get(r.body.snapshot_id) ?? []);
        if (newer) class3.push({ dec, evaluationId: newer.evaluation_id });
      }
      class3.sort((a, b) => (a.dec.created_at < b.dec.created_at ? 1 : a.dec.created_at > b.dec.created_at ? -1
        : a.dec.decision_id < b.dec.decision_id ? -1 : a.dec.decision_id > b.dec.decision_id ? 1 : 0));
      for (const c of class3) add(c.dec, 'cross_judge_disagreement', c.evaluationId);
    }

    const opened: SampledTask[] = [];
    for (const p of picked) {
      const snap = await repos.getSnapshot(q, tenantId, p.dec.decision.snapshot_id);
      const reviewId = await openSampledReviewTask(q, p.dec.decision,
        { run_id: snap?.run_id ?? null, tool: snap?.candidate_action?.tool ?? null }, p.reason, p.evaluationId);
      if (!reviewId) continue;
      opened.push({ review_id: reviewId, decision_id: p.dec.decision_id, reason: p.reason });
      // Every connected review panel refreshes on this (not only the one that pressed "Sample").
      await repos.appendOutbox(q, { tenant_id: tenantId, kind: 'review', ref_id: reviewId, run_id: snap?.run_id ?? null,
        payload: { review_id: reviewId, decision_id: p.dec.decision_id, status: 'open', sample_reason: p.reason } });
    }
    return opened;
  });
}
