// The /v1/systemone wire protocol (TypeSafe System One; Kev serves the same API),
// our validated Signal, and the EvaluationRecord (RFC §6.1, §6.3, §6.4).
import { z } from 'zod';
import { Id, Iso } from './common.ts';

// ---- wire: request -------------------------------------------------------
export const WireQuestion = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), instructions: z.string() }),
  z.object({ type: z.literal('choice'), instructions: z.string(),
    criteria: z.record(z.string(), z.string().nullable()) }),
  z.object({ type: z.literal('score'), instructions: z.string(), criteria: z.array(z.string()).min(2) }),
]);
export type WireQuestion = z.infer<typeof WireQuestion>;

export const SystemOneRequest = z.object({
  model: z.string(),
  state: z.string(),
  questions: z.record(z.string(), WireQuestion),
});
export type SystemOneRequest = z.infer<typeof SystemOneRequest>;

// ---- wire: response (as observed from Kev, runs/spike-2026-09-28) --------
export const WireAnswer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: z.number() }),
  z.object({ type: z.literal('choice'), choice: z.string(), confidence: z.number().optional(),
    probabilities: z.record(z.string(), z.number()) }),
  z.object({ type: z.literal('score'), score: z.number(), confidence: z.number().optional(),
    legend: z.record(z.string(), z.string()), probabilities: z.record(z.string(), z.number()) }),
]);
export const SystemOneResponse = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.unknown()),     // each validated separately (a bad answer must not hide good ones)
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).partial().optional(),
  latency_ms: z.number().optional(),
});
export type SystemOneResponse = z.infer<typeof SystemOneResponse>;

// ---- served-model identity (from GET /v1/models) --------------------------
export const ServedModel = z.object({
  backend: z.enum(['kev-local', 'typesafe', 'stub']),
  run: z.string(),                 // e.g. "jaredpalmer/kev-4b" or "jev-1.13.0"
  base: z.string().nullable(),
  revision: z.string().nullable(), // HF snapshot / vendor version
  temperature: z.number().nullable(),
  runtime: z.string().nullable(),  // "mlx/bfloat16/mps", ...
});
export type ServedModel = z.infer<typeof ServedModel>;
/** The provenance string shown everywhere, e.g. "kev-local:jaredpalmer/kev-4b@139fdd94". */
export const judgeSourceOf = (m: ServedModel): string =>
  `${m.backend}:${m.run}${m.revision ? '@' + m.revision.slice(0, 8) : ''}`;

// ---- internal Signal (RFC §6.3) --------------------------------------------
export const Signal = z.object({
  question_id: z.string(),
  type: z.enum(['noul', 'choice', 'score']),
  raw_probability: z.number().min(0).max(1).nullable(),        // noul only
  choice: z.string().nullable(),
  probabilities: z.record(z.string(), z.number()).nullable(),  // choice / score: full distribution
  vendor_confidence: z.number().nullable(),                    // as returned; null for noul
  score: z.number().nullable(),
  legend: z.record(z.string(), z.string()).nullable(),
  margin_local: z.number().nullable(),                         // locally derived top1-top2 (|2p-1| for noul)
  p_calibrated: z.number().nullable(),                         // null unless a matching calibration is active
  calibration_id: z.string().nullable(),
});
export type Signal = z.infer<typeof Signal>;

export const EvaluationStatus = z.enum([
  'ok', 'partial', 'timeout', 'http_error', 'rate_limited', 'invalid_response', 'model_mismatch',
  'skipped_hard_rule', 'not_configured', 'expired',
]);
export type EvaluationStatus = z.infer<typeof EvaluationStatus>;

export const EvaluationRecord = z.object({
  evaluation_id: Id,
  tenant_id: Id,
  event_id: Id,
  snapshot_id: Id,
  kind: z.enum(['realtime', 'diagnostic', 'model_reeval']),
  rubric_id: z.string(),
  question_ids: z.array(z.string()),
  required_question_ids: z.array(z.string()),
  judge_source: z.string().nullable(),
  served_model: ServedModel.nullable(),
  request_hash: z.string(),
  client_request_id: Id,
  vendor_request_id: z.string().nullable(),
  status: EvaluationStatus,
  http_status: z.number().int().nullable(),
  attempts: z.number().int(),
  judge_http_rtt_ms: z.number().nullable(),                    // measured, monotonic clock
  vendor_latency_ms: z.number().nullable(),                    // as reported by the server; not our measurement
  usage: z.object({ input_tokens: z.number().nullable(), output_tokens: z.number().nullable() }).nullable(),
  billing: z.enum(['metered', 'local_compute', 'unknown', 'none']),
  signals: z.record(z.string(), Signal),
  errors: z.array(z.string()),
  started_at: Iso,
  finished_at: Iso.nullable(),
});
export type EvaluationRecord = z.infer<typeof EvaluationRecord>;
