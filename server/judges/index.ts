// T1 (deepseek) implements. /v1/systemone client + RFC §6.4 validator + limiter.
// One client for every backend: Kev (local) and TypeSafe (hosted) speak the same protocol.
import type { EvaluationStatus, ServedModel, Signal, SystemOneRequest } from '../../contracts/judge.ts';

export interface JudgeConfig {
  backend: 'kev-local' | 'typesafe' | 'stub';
  baseUrl: string;                 // e.g. http://127.0.0.1:8009 ; https://api.typesafe.ai
  apiKey?: string;                 // secret: never logged, never returned, never in errors (T3 canary test)
  model: string;                   // wire model name, e.g. "kev-latest" or "jev-1.13.0"
  expectedRun?: string;            // if set, /v1/models must report this run, else status model_mismatch
  maxRps: number;                  // plan: 10 by default (RFC §6.5)
  maxInputTokensPerSec: number;
  maxResponseBytes: number;        // body cap (RFC §6.4)
}

export type JudgeCaller = 'realtime' | 'diagnostic' | 'model_reeval' | 'preflight' | 'eval' | 'healthcheck';

export interface JudgeCallOptions {
  tenantId: string;
  evaluationId: string | null;
  caller: JudgeCaller;
  /** Absolute budget for this call incl. queueing in the limiter; no implicit retries past it (RFC §6.5). */
  deadlineMs: number;
  /** Shadow may retry 429/529 with backoff inside the deadline; gate/preflight never retries. */
  retry429: boolean;
}

export interface JudgeCallResult {
  status: EvaluationStatus;        // ok | partial | timeout | http_error | rate_limited | invalid_response | model_mismatch | not_configured
  http_status: number | null;
  attempts: number;
  judge_http_rtt_ms: number | null;   // measured with a monotonic clock, last attempt, full body read
  vendor_latency_ms: number | null;   // response.latency_ms if present
  usage: { input_tokens: number | null; output_tokens: number | null } | null;
  billing: 'metered' | 'local_compute' | 'unknown' | 'none';  // 'unknown' when aborted after send (RFC §6.5)
  vendor_request_id: string | null;   // x-typesafe-request-id header if present
  request_hash: string;
  client_request_id: string;
  signals: Record<string, Signal>;    // only questions whose answers validated
  errors: string[];                   // human-readable; must never contain the api key
  served_model: ServedModel | null;
}

export interface JudgeClient {
  readonly config: Readonly<Omit<JudgeConfig, 'apiKey'>>;
  /** GET /v1/models → identity of what is actually served (the only source of judge_source). */
  describe(): Promise<ServedModel | null>;
  served(): ServedModel | null;
  call(req: SystemOneRequest, requiredQuestionIds: string[], opts: JudgeCallOptions): Promise<JudgeCallResult>;
}

/** Row written for every outbound attempt (judge_calls table). */
export interface JudgeLedgerRow {
  tenant_id: string; evaluation_id: string | null; caller: JudgeCaller; client_request_id: string;
  request_hash: string; judge_source: string | null; status: string; http_status: number | null;
  rtt_ms: number | null; input_tokens: number | null; output_tokens: number | null; billing: string;
}

export function createJudgeClient(cfg: JudgeConfig, deps: { ledger: (row: JudgeLedgerRow) => Promise<void> }): JudgeClient {
  throw new Error('createJudgeClient: not implemented (T1)');
}

/**
 * RFC §6.4 validation of one raw response against its request. Pure.
 * - noul: finite 0..1 → raw_probability; vendor_confidence null; margin_local |2p-1|.
 * - choice: option set equals request criteria keys; probabilities finite, sum 1 ± 0.01; choice = argmax.
 * - score: legend levels match request criteria; probabilities over "0".."n-1"; score in [0, n-1].
 * - a missing/invalid REQUIRED answer → status invalid_response (never 0 risk); optional ones → partial.
 * - p_calibrated and calibration_id are always null here (calibration is policy's job).
 */
export function validateResponse(req: SystemOneRequest, raw: unknown, requiredQuestionIds: string[]):
  { status: 'ok' | 'partial' | 'invalid_response'; signals: Record<string, Signal>; errors: string[] } {
  throw new Error('validateResponse: not implemented (T1)');
}

/** sha256:<hex> of canonical JSON (sorted keys) of the request. */
export function requestHash(req: SystemOneRequest): string {
  throw new Error('requestHash: not implemented (T1)');
}
