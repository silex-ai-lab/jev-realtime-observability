// BoundaryEvent: what was actually observed (RFC §5.2). Tenant is never in the body;
// the server derives it from the credential and adds received_at.
import { z } from 'zod';
import { Authenticity, Boundary, Digest, Id, InstructionAuthority, Iso, SCHEMA_VERSION } from './common.ts';

export const SourceExcerpt = z.object({
  id: Id,
  producer: z.string().max(120),              // connector that captured it, e.g. "sandbox.erp"
  authenticity: Authenticity,
  instruction_authority: InstructionAuthority,
  excerpt: z.string().max(4000),
  offset: z.number().int().nonnegative().optional(),
  digest: Digest.optional(),
});
export type SourceExcerpt = z.infer<typeof SourceExcerpt>;

export const Operation = z.object({
  tool: z.string().max(120),
  operation_id: Id,                            // business idempotency / correlation key
  args: z.record(z.string(), z.unknown()),     // redacted per tool registry before storage
  args_digest: Digest,                         // sha256 of canonical JSON of the full args
});
export type Operation = z.infer<typeof Operation>;

export const BoundaryEvent = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  event_id: Id,                                // unique per event; never equal to span_id by construction
  source_event_id: Id.optional(),              // shared by an SDK event and its OTLP mirror (dedup)
  run_id: Id,
  trace_id: z.string().regex(/^[0-9a-f]{32}$/),
  span_id: z.string().regex(/^[0-9a-f]{16}$/).optional(),
  parent_span_id: z.string().regex(/^[0-9a-f]{16}$/).optional(),
  producer_id: Id,
  producer_seq: z.number().int().nonnegative(),
  boundary: Boundary,
  occurred_at: Iso,
  tool_call_id: Id.optional(),
  actor: z.object({ kind: z.enum(['agent', 'user', 'tool', 'system']), id: Id }),
  task_goal: z.string().max(2000).optional(),  // only on run_started / pre_input from an authenticated user
  operation: Operation.optional(),             // pre_tool / post_tool
  result: z.object({ status: z.enum(['ok', 'error']), http_status: z.number().int().optional(),
    body: z.record(z.string(), z.unknown()).optional() }).optional(),  // post_tool: as reported by the tool
  text: z.string().max(8000).optional(),       // post_generation draft / claim text
  sources: z.array(SourceExcerpt).max(32).default([]),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});
export type BoundaryEvent = z.infer<typeof BoundaryEvent>;
export type BoundaryEventInput = z.input<typeof BoundaryEvent>;

/** What the server stores: the event plus server-derived fields. */
export type StoredEvent = BoundaryEvent & {
  tenant_id: string;
  received_at: string;
  ingest_path: 'sdk' | 'otlp';
};
