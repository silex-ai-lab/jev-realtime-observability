// Gate C: synchronous pre-tool control (RFC §3.1 control path, §6.5, §7.1).
// The tool wrapper asks /v1/preflight before a side effect and receives a ControlDecision bound to
// exactly this call; the gateway re-verifies the binding and the authority state before executing.
import { z } from 'zod';
import { Digest, Id, SCHEMA_VERSION } from './common.ts';
import { SourceExcerpt } from './events.ts';

export const PreflightRequest = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  event_id: Id,                         // the pre_tool event this preflight records (stored like any event)
  run_id: Id,
  trace_id: z.string().regex(/^[0-9a-f]{32}$/),
  producer_id: Id,
  producer_seq: z.number().int().nonnegative(),
  actor: z.object({ kind: z.enum(['agent', 'user', 'tool', 'system']), id: Id }),
  operation: z.object({ tool: z.string(), operation_id: Id, args: z.record(z.string(), z.unknown()), args_digest: Digest }),
  sources: z.array(SourceExcerpt).max(32).default([]),
});
export type PreflightRequest = z.infer<typeof PreflightRequest>;

export const PreflightResponse = z.object({
  control: z.object({
    control_id: Id, tenant_id: Id, run_id: Id, actor_id: Id, tool: z.string(), operation_id: Id, args_digest: Digest,
    policy_version: z.string(), snapshot_id: Id, authorization_version: z.string(),
    action: z.enum(['allow', 'hold_for_review', 'hold_for_approval', 'deny']),
    issued_at: z.string(), expires_at: z.string(), nonce: z.string().min(16),
  }),
  decision: z.object({ decision_id: Id, recommended: z.string(), decided_by: z.string(), reasons: z.array(z.string()) }),
  timings: z.object({ total_ms: z.number(), judge_http_rtt_ms: z.number().nullable(), judge_budget_ms: z.number() }),
});
export type PreflightResponse = z.infer<typeof PreflightResponse>;

/** RFC §6.5 budgets for the synchronous path. */
export const GATE_BUDGET = Object.freeze({ totalMs: 600, judgeMaxMs: 400, commitMarginMs: 60, controlTtlMs: 30_000 });
