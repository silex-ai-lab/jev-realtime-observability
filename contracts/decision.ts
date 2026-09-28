// Rule results, policy decisions (risk conclusion separate from action), and the
// Gate B/C records: ControlDecision, ExecutionReceipt, OutcomeObservation (RFC §7, §8).
import { z } from 'zod';
import { Digest, Id, Iso, Provenance } from './common.ts';

export const RuleVerdict = z.enum(['PASS', 'ALERT', 'HOLD', 'BLOCK', 'STOP']);
export type RuleVerdict = z.infer<typeof RuleVerdict>;

export const RuleResult = z.object({
  rule_id: z.string(),
  verdict: RuleVerdict,
  reason: z.string(),
  evidence_refs: z.array(z.string()),
  authoritative_source: z.string(),     // e.g. "sandbox.erp.approvals"; never the agent's own claim
});
export type RuleResult = z.infer<typeof RuleResult>;

/** Recommendation ladder, RFC §7 order. NO_CONFIGURED_RISK is not "safe". */
export const Recommendation = z.enum([
  'REJECT', 'STOP', 'BLOCK', 'HOLD', 'UNKNOWN', 'REVIEW', 'ALERT', 'NO_CONFIGURED_RISK',
]);
export type Recommendation = z.infer<typeof Recommendation>;

export const DecidedBy = z.enum(['auth', 'rule', 'evidence_gate', 'judge_unavailable', 'semantic', 'default']);

export const PolicyDecision = z.object({
  decision_id: Id,
  tenant_id: Id,
  event_id: Id,
  evaluation_id: Id.nullable(),
  snapshot_id: Id,
  policy_version: z.string(),
  provenance: Provenance,
  recommended: Recommendation,
  decided_by: DecidedBy,
  /** Shadow: the action that would have been requested; enforced_action stays null. */
  would_have: z.string().nullable(),
  enforced_action: z.string().nullable(),
  reasons: z.array(z.string()),
  rule_results: z.array(RuleResult),
  semantic: z.object({
    calibrated: z.boolean(),
    hits: z.array(z.object({ question_id: z.string(), value: z.number(), band: z.string() })),
  }),
  coverage_gaps: z.array(z.string()),
  timings: z.object({                    // measured, ms, monotonic
    ingest_to_signal_ms: z.number().nullable(),
    snapshot_ms: z.number().nullable(),
    rules_ms: z.number().nullable(),
    judge_http_rtt_ms: z.number().nullable(),
    policy_ms: z.number().nullable(),
  }),
  created_at: Iso,
});
export type PolicyDecision = z.infer<typeof PolicyDecision>;

// ---- Gate C ---------------------------------------------------------------
export const ControlDecision = z.object({
  control_id: Id,
  tenant_id: Id,
  run_id: Id,
  actor_id: Id,
  tool: z.string(),
  operation_id: Id,
  args_digest: Digest,
  policy_version: z.string(),
  snapshot_id: Id,
  authorization_version: z.string(),
  action: z.enum(['allow', 'hold_for_review', 'hold_for_approval', 'deny']),
  issued_at: Iso,
  expires_at: Iso,
  nonce: z.string().min(16),
});
export type ControlDecision = z.infer<typeof ControlDecision>;

export const ExecutionReceipt = z.object({
  receipt_id: Id,
  tenant_id: Id,
  control_id: Id.nullable(),             // null in shadow mode
  operation_id: Id,
  tool: z.string(),
  args_digest: Digest,
  status: z.enum(['executed', 'not_executed', 'failed']),
  reason: z.string(),
  resource_ref: z.string().nullable(),   // e.g. ledger transaction id
  at: Iso,
});
export type ExecutionReceipt = z.infer<typeof ExecutionReceipt>;

export const OutcomeState = z.enum(['not_observed', 'pending', 'verified_success', 'verified_failure', 'mismatch', 'unknown_after_deadline']);
export const OutcomeObservation = z.object({
  outcome_id: Id,
  tenant_id: Id,
  operation_id: Id,
  state: OutcomeState,
  checked: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  source: z.string(),
  observed_at: Iso,
});
export type OutcomeObservation = z.infer<typeof OutcomeObservation>;
