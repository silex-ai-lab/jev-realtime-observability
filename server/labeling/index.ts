// Active-learning sampler (T7; plan batch 2 D3): opens review tasks for the most informative original
// decisions that have no review task yet. Three classes in priority order, newest first within a class:
//   1. uncertain                    — a required risk question answered 0.3–0.7 by the realtime judge;
//   2. judge_flags_unruled_risk     — no rule held it, but a realtime risk answer is ≥ 0.7 (a heuristic);
//   3. cross_judge_disagreement     — two valid evaluations of the same snapshot by different served models
//                                     disagree on a risk question across 0.5.
// Only valid evidence counts: evaluations with status ok/partial and non-null raw_probability. Only the risk
// questions instruction_override / goal_deviation / sensitive_data_transfer are compared.
import type { Db } from '../storage/db.ts';
import type { SampleReason } from '../../contracts/labels.ts';
import type { PolicyDecision } from '../../contracts/decision.ts';
import type { EvaluationRecord } from '../../contracts/judge.ts';
import * as repos from '../storage/repos.ts';
import { openSampledReviewTask } from '../storage/reviews.ts';

export interface SampledTask { review_id: string; decision_id: string; reason: SampleReason }

const RISK_QUESTIONS = new Set(['instruction_override', 'goal_deviation', 'sensitive_data_transfer']);
const HARD_RULE = new Set(['HOLD', 'BLOCK', 'STOP']);

interface DecRow { decision_id: string; evaluation_id: string | null; created_at: string; decision: PolicyDecision }
interface EvRow { evaluation_id: string; snapshot_id: string; created_at: string; ev: EvaluationRecord }

const prob = (ev: EvaluationRecord, qid: string): number | null =>
  ev.signals?.[qid] && typeof ev.signals[qid].raw_probability === 'number' ? (ev.signals[qid].raw_probability as number) : null;

const runOf = (ev: EvaluationRecord): string | null => ev.served_model?.run ?? null;

function uncertain(ev: EvaluationRecord): boolean {
  if (ev.kind !== 'realtime') return false;
  const req = ev.required_question_ids ?? [];
  if (!req.length) return false;
  return req.some(qid => {
    if (!RISK_QUESTIONS.has(qid)) return false;
    const x = prob(ev, qid);
    return x != null && x >= 0.3 && x <= 0.7;
  });
}

function judgeFlagsUnruledRisk(d: PolicyDecision, ev: EvaluationRecord): boolean {
  if (ev.kind !== 'realtime') return false;
  if ((d.rule_results ?? []).some(r => HARD_RULE.has(r.verdict))) return false;
  for (const qid of RISK_QUESTIONS) {
    const x = prob(ev, qid);
    if (x != null && x >= 0.7) return true;
  }
  return false;
}

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

/** Opens at most `budget` sampler tasks for the tenant in one transaction; returns what it opened. */
export async function sampleForReview(db: Db, tenantId: string, budget: number): Promise<SampledTask[]> {
  return db.tx(async q => {
    const decQ = await q.query<{ decision_id: string; evaluation_id: string | null; created_at: string; body: PolicyDecision }>(
      `SELECT decision_id, evaluation_id, created_at::text AS created_at, body FROM decisions
       WHERE tenant_id = $1 AND replay_of IS NULL
         AND NOT EXISTS (SELECT 1 FROM review_tasks t WHERE t.tenant_id = decisions.tenant_id AND t.decision_id = decisions.decision_id)
       ORDER BY created_at DESC, decision_id`,
      [tenantId]);
    const decisions: DecRow[] = decQ.rows.map(r => ({ decision_id: r.decision_id, evaluation_id: r.evaluation_id, created_at: r.created_at, decision: r.body }));

    const evQ = await q.query<{ evaluation_id: string; snapshot_id: string; created_at: string; body: EvaluationRecord }>(
      `SELECT evaluation_id, snapshot_id, created_at::text AS created_at, body FROM evaluations
       WHERE tenant_id = $1 AND status IN ('ok', 'partial')`,
      [tenantId]);
    const evals: EvRow[] = evQ.rows.map(r => ({ evaluation_id: r.evaluation_id, snapshot_id: r.snapshot_id, created_at: r.created_at, ev: r.body }));
    const evalById = new Map(evals.map(e => [e.evaluation_id, e]));

    const picked: Array<{ dec: DecRow; reason: SampleReason; evaluationId: string }> = [];
    const taken = new Set<string>();
    const add = (dec: DecRow, reason: SampleReason, evaluationId: string) => {
      if (taken.has(dec.decision_id) || picked.length >= budget) return;
      taken.add(dec.decision_id);
      picked.push({ dec, reason, evaluationId });
    };

    // class 1
    for (const d of decisions) {
      if (picked.length >= budget) break;
      if (!d.evaluation_id) continue;
      const ev = evalById.get(d.evaluation_id);
      if (!ev) continue;
      if (uncertain(ev.ev)) add(d, 'uncertain', d.evaluation_id);
    }
    // class 2
    for (const d of decisions) {
      if (picked.length >= budget) break;
      if (taken.has(d.decision_id) || !d.evaluation_id) continue;
      const ev = evalById.get(d.evaluation_id);
      if (!ev) continue;
      if (judgeFlagsUnruledRisk(d.decision, ev.ev)) add(d, 'judge_flags_unruled_risk', d.evaluation_id);
    }
    // class 3
    const bySnapshot = new Map<string, EvRow[]>();
    for (const e of evals) {
      const list = bySnapshot.get(e.snapshot_id);
      if (list) list.push(e); else bySnapshot.set(e.snapshot_id, [e]);
    }
    const decisionBySnapshot = new Map(decisions.map(d => [d.decision.snapshot_id, d]));
    const class3: Array<{ dec: DecRow; evaluationId: string }> = [];
    for (const [snapId, es] of bySnapshot) {
      const dec = decisionBySnapshot.get(snapId);
      if (!dec || taken.has(dec.decision_id)) continue;
      const newer = findDisagreement(es);
      if (newer) class3.push({ dec, evaluationId: newer.evaluation_id });
    }
    // decisions already come newest-first from SQL; class3 candidates reference them, so preserve that order.
    const newestFirst = new Map(decisions.map((d, i) => [d.decision_id, i]));
    class3.sort((a, b) => (newestFirst.get(a.dec.decision_id) ?? 0) - (newestFirst.get(b.dec.decision_id) ?? 0));
    for (const c of class3) {
      if (picked.length >= budget) break;
      add(c.dec, 'cross_judge_disagreement', c.evaluationId);
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
