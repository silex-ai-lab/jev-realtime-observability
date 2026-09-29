// Labels and review tasks (docs/CONTRACTS.md §10; RFC §7, §12.2). Labels are the training/eval record:
// one answer to one rubric question about one judge view (a snapshot) or one evaluation.
import { z } from 'zod';
import type { WireQuestion } from './judge.ts';

export const EvidenceClass = z.enum(['benchmark_ground_truth_derived', 'heuristic_derived', 'human_reviewed']);
export type EvidenceClass = z.infer<typeof EvidenceClass>;

export const LabelInput = z.object({
  ref: z.string().min(1).max(200),          // an evaluation_id or a snapshot_id of the caller's tenant
  question_id: z.string().min(1).max(100),
  value: z.unknown(),
  evidence_class: EvidenceClass,
  source: z.string().min(1).max(200),
}).strict();
export type LabelInput = z.infer<typeof LabelInput>;

export interface Label {
  label_id: string; tenant_id: string; ref: string; question_id: string; value: boolean | string;
  evidence_class: EvidenceClass; source: string; created_at: string;
}

export const ReviewResolve = z.object({
  outcome: z.enum(['allow', 'deny']),
  answers: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type ReviewResolve = z.infer<typeof ReviewResolve>;

export type SampleReason = 'uncertain' | 'judge_flags_unruled_risk' | 'cross_judge_disagreement';

export type ReviewStatus = 'open' | 'resolved_allow' | 'resolved_deny' | 'expired';
export interface ReviewTask {
  review_id: string; tenant_id: string; decision_id: string; status: ReviewStatus; created_at: string;
  body: {
    path: 'worker' | 'preflight' | 'sampler'; event_id: string; run_id: string | null; snapshot_id: string; evaluation_id: string | null;
    recommended: string; decided_by: string; tool: string | null; reasons: string[];
    /** Sampler tasks only (T7): why the active-learning sampler picked this decision. */
    sample_reason?: SampleReason;
    resolution?: { outcome: 'allow' | 'deny'; actor: string; at: string; label_ids: string[] };
  };
}

/** Checks a label value against its question's wire type: noul → boolean; choice → a criteria key;
 *  score → one of the criteria levels. Returns an error message, or null when valid. */
export function labelValueError(q: WireQuestion, value: unknown): string | null {
  if (q.type === 'noul') return typeof value === 'boolean' ? null : 'noul answers are booleans';
  if (q.type === 'choice') return typeof value === 'string' && Object.hasOwn(q.criteria, value) ? null : `choice answer must be one of ${Object.keys(q.criteria).join(', ')}`;
  return typeof value === 'string' && q.criteria.includes(value) ? null : `score answer must be one of ${q.criteria.join(', ')}`;
}
