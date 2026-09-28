// DecisionSnapshot: the frozen, decision-time view one evaluation uses (RFC §5.3–5.5).
// Built only from events observed at or before the triggering event, plus authoritative
// sandbox records. Late events create a new revision; they never rewrite this one.
import { z } from 'zod';
import { Authenticity, Boundary, Id, Impact, InstructionAuthority, Iso } from './common.ts';

export const SnapshotEvidence = z.object({
  ref: z.string(),                           // "event:<id>", "source:<id>", "authority:po/PO-4410", ...
  kind: z.enum(['task', 'tool_args', 'tool_result', 'source', 'authority_record', 'history']),
  authenticity: Authenticity,
  instruction_authority: InstructionAuthority,
  excerpt: z.string(),
  truncated: z.boolean(),
});
export type SnapshotEvidence = z.infer<typeof SnapshotEvidence>;

export const DecisionSnapshot = z.object({
  snapshot_id: Id,
  tenant_id: Id,
  run_id: Id,
  event_id: Id,
  boundary: Boundary,
  as_of: Iso,                                // received_at of the triggering event
  cutoff_seq: z.number().int(),              // producer_seq of the triggering event (per producer)
  extractor_version: z.string(),
  task_goal: z.object({ text: z.string(), source: z.string() }).nullable(),
  candidate_action: z.object({
    tool: z.string(), operation_id: Id, impact: Impact, args_summary: z.record(z.string(), z.unknown()),
  }).nullable(),
  history: z.array(z.object({ event_id: Id, boundary: Boundary, tool: z.string().nullable(), status: z.string() })),
  evidence: z.array(SnapshotEvidence),
  /** Code-derived facts. Exact amounts, limits, dates and counts are compared here, not by the model. */
  facts: z.record(z.string(), z.union([z.boolean(), z.string(), z.number(), z.null()])),
  required_evidence: z.array(z.string()),
  missing_evidence: z.array(z.string()),
  stale_evidence: z.array(z.string()),
  /** The minimal state sent to the judge (plan D6: ≤ judge_view_max_tokens). */
  judge_view: z.object({ state: z.string(), token_estimate: z.number().int(), truncated: z.boolean() }),
});
export type DecisionSnapshot = z.infer<typeof DecisionSnapshot>;
