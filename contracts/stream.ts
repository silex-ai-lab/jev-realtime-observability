// SSE stream records, read from the persisted outbox by cursor (RFC §9.1).
import { z } from 'zod';

export const StreamKind = z.enum([
  'event', 'evaluation', 'decision', 'coverage_gap', 'evaluation_expired', 'outcome', 'receipt', 'run', 'review',
]);
export type StreamKind = z.infer<typeof StreamKind>;

export const StreamRecord = z.object({
  cursor: z.string(),              // bigint as string; resume with ?cursor= or Last-Event-ID
  kind: StreamKind,
  ref_id: z.string(),
  run_id: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  at: z.string(),
});
export type StreamRecord = z.infer<typeof StreamRecord>;
