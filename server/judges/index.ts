// T1 (deepseek). /v1/systemone client + RFC §6.4 validator + limiter.
// One client for every backend: Kev (local) and TypeSafe (hosted) speak the same protocol.
import { randomUUID } from 'node:crypto';
import type { EvaluationStatus, ServedModel, Signal, SystemOneRequest } from '../../contracts/judge.ts';
import { judgeSourceOf } from '../../contracts/judge.ts';
import { CallLimiter, estimateInputTokens, monotonicMs, readBodyCapped } from './limiter.ts';
import { requestHash, validateResponse } from './validate.ts';

export { requestHash, validateResponse } from './validate.ts';

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

interface AttemptOutcome {
  status: 'ok' | 'partial' | 'invalid_response' | 'timeout' | 'http_error' | 'rate_limited';
  http_status: number | null;
  rtt: number | null;
  usage: { input_tokens: number | null; output_tokens: number | null } | null;
  vendor_latency_ms: number | null;
  vendor_request_id: string | null;
  signals: Record<string, Signal>;
  errors: string[];
  abortedAfterSend: boolean;
}

/**
 * Maps one /v1/models entry (Kev's shape) to ServedModel. `backend` is the JudgeConfig backend
 * (kev-local/typesafe/stub), never the compute backend reported in the models payload; the compute
 * backend/dtype/device are folded into `runtime`. `revision` is the HF snapshot hash if derivable.
 */
export function mapServedModel(backend: JudgeConfig['backend'], m: unknown): ServedModel | null {
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  const run = typeof o.run === 'string' ? o.run : (typeof o.name === 'string' ? o.name : null);
  if (!run) return null;
  const base = typeof o.base === 'string' ? o.base : null;
  const revision = typeof o.revision === 'string' ? o.revision : (typeof o.snapshot === 'string' ? o.snapshot : null);
  const temperature = typeof o.temperature === 'number' && Number.isFinite(o.temperature) ? o.temperature : null;
  const runtimeParts = [o.backend, o.dtype, o.device].filter(x => typeof x === 'string') as string[];
  const runtime = runtimeParts.length ? runtimeParts.join('/') : null;
  return { backend, run, base, revision, temperature, runtime };
}

const billingFor = (backend: JudgeConfig['backend'], abortedAfterSend: boolean, hasUsage: boolean):
  'metered' | 'local_compute' | 'unknown' | 'none' => {
  if (abortedAfterSend) return 'unknown';
  if (backend === 'kev-local') return 'local_compute';
  if (backend === 'typesafe') return hasUsage ? 'metered' : 'none';
  return 'none';
};

const redact = (s: string, key?: string): string => (key ? s.split(key).join('[REDACTED]') : s);
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const extractUsage = (parsed: unknown): { input_tokens: number | null; output_tokens: number | null } | null => {
  if (!parsed || typeof parsed !== 'object') return null;
  const u = (parsed as { usage?: unknown }).usage;
  if (!u || typeof u !== 'object') return null;
  const input = finite((u as { input_tokens?: unknown }).input_tokens) ? (u as { input_tokens: number }).input_tokens : null;
  const output = finite((u as { output_tokens?: unknown }).output_tokens) ? (u as { output_tokens: number }).output_tokens : null;
  return (input !== null || output !== null) ? { input_tokens: input, output_tokens: output } : null;
};
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const extractLatency = (parsed: unknown): number | null =>
  (parsed && typeof parsed === 'object' && finite((parsed as { latency_ms?: unknown }).latency_ms))
    ? (parsed as { latency_ms: number }).latency_ms : null;

export function createJudgeClient(cfg: JudgeConfig, deps: { ledger: (row: JudgeLedgerRow) => Promise<void> }): JudgeClient {
  const limiter = new CallLimiter(cfg.maxRps, cfg.maxInputTokensPerSec);
  const { apiKey, ...publicConfig } = cfg;
  const base = cfg.baseUrl.replace(/\/+$/, '');
  let servedModel: ServedModel | null = null;
  // A failed /v1/models lookup is not retried on every call: this bounds the total gate latency when
  // the judge's models endpoint is unreachable, while still allowing recovery after a short cooldown.
  let describeFailedUntil = 0;
  const DESCRIBE_FAIL_COOLDOWN_MS = 30_000;

  async function describe(timeoutMs = 5000): Promise<ServedModel | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
      try {
        const res = await fetch(`${base}/v1/models`, { signal: controller.signal });
        if (!res.ok) return null;
        const json = await res.json();
        const models: unknown[] = Array.isArray(json) ? json
          : (json && typeof json === 'object' && Array.isArray((json as { models?: unknown }).models)
            ? (json as { models: unknown[] }).models : [json]);
        for (const m of models) {
          const sm = mapServedModel(cfg.backend, m);
          if (sm) { servedModel = sm; return sm; }
        }
        return null;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return null;
    }
  }

  async function sendOnce(req: SystemOneRequest, requiredQuestionIds: string[], deadline: number): Promise<AttemptOutcome> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('judge deadline exceeded')), Math.max(0, deadline - monotonicMs()));
    const rttStart = monotonicMs();
    const fail = (status: AttemptOutcome['status'], http_status: number | null, rtt: number, errors: string[]): AttemptOutcome =>
      ({ status, http_status, rtt, usage: null, vendor_latency_ms: null, vendor_request_id: null, signals: {}, errors, abortedAfterSend: false });
    try {
      const res = await fetch(`${base}/v1/systemone`, { method: 'POST', headers, body: JSON.stringify(req), signal: controller.signal });
      const vendorRequestId = res.headers.get('x-typesafe-request-id');
      const { text, truncated, aborted } = await readBodyCapped(res, cfg.maxResponseBytes, controller.signal);
      const rtt = monotonicMs() - rttStart;
      if (aborted) return { status: 'timeout', http_status: null, rtt, usage: null, vendor_latency_ms: null, vendor_request_id: null, signals: {}, errors: ['deadline exceeded reading response'], abortedAfterSend: true };
      if (truncated) return fail('invalid_response', res.status, rtt, [`response body exceeded ${cfg.maxResponseBytes} bytes`]);
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { return fail('invalid_response', res.status, rtt, ['response is not valid JSON']); }
      if (res.status === 429 || res.status === 529) return fail('rate_limited', res.status, rtt, [`HTTP ${res.status} rate limited`]);
      if (!res.ok) return fail('http_error', res.status, rtt, [`HTTP ${res.status}`]);
      const validation = validateResponse(req, parsed, requiredQuestionIds);
      return {
        status: validation.status, http_status: res.status, rtt, usage: extractUsage(parsed),
        vendor_latency_ms: extractLatency(parsed), vendor_request_id: vendorRequestId,
        signals: validation.signals, errors: validation.errors, abortedAfterSend: false,
      };
    } catch (e) {
      const rtt = monotonicMs() - rttStart;
      if (controller.signal.aborted) return { status: 'timeout', http_status: null, rtt, usage: null, vendor_latency_ms: null, vendor_request_id: null, signals: {}, errors: ['deadline exceeded'], abortedAfterSend: true };
      return fail('http_error', null, rtt, [redact(String(e), apiKey)]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function call(req: SystemOneRequest, requiredQuestionIds: string[], opts: JudgeCallOptions): Promise<JudgeCallResult> {
    const deadline = monotonicMs() + opts.deadlineMs;
    const clientRequestId = `req-${randomUUID()}`;
    const rh = requestHash(req);

    // Bound the /v1/models lookup by the remaining call deadline (never more than the default 5 s),
    // and cache a failure so a missing models endpoint cannot push the call past its budget.
    if (servedModel === null && monotonicMs() > describeFailedUntil) {
      const remaining = Math.max(1, deadline - monotonicMs());
      await describe(Math.min(5000, remaining));
      if (servedModel === null) describeFailedUntil = monotonicMs() + DESCRIBE_FAIL_COOLDOWN_MS;
    }

    if (cfg.expectedRun) {
      if (servedModel && servedModel.run !== cfg.expectedRun) {
        return {
          status: 'model_mismatch', http_status: null, attempts: 0, judge_http_rtt_ms: null,
          vendor_latency_ms: null, usage: null, billing: 'none', vendor_request_id: null,
          request_hash: rh, client_request_id: clientRequestId, signals: {}, served_model: servedModel,
          errors: [`served run ${servedModel.run} differs from expectedRun ${cfg.expectedRun}`],
        };
      }
    }

    const judgeSource = servedModel ? judgeSourceOf(servedModel) : null;
    let attempts = 0;
    let last: AttemptOutcome | null = null;

    for (;;) {
      if (monotonicMs() >= deadline) break;
      try { await limiter.acquire(estimateInputTokens(req), deadline); } catch { break; }
      if (monotonicMs() >= deadline) break;
      const outcome = await sendOnce(req, requiredQuestionIds, deadline);
      attempts++;
      last = outcome;
      await deps.ledger({
        tenant_id: opts.tenantId, evaluation_id: opts.evaluationId, caller: opts.caller,
        client_request_id: clientRequestId, request_hash: rh, judge_source: judgeSource,
        status: outcome.status, http_status: outcome.http_status, rtt_ms: outcome.rtt,
        input_tokens: outcome.usage?.input_tokens ?? null, output_tokens: outcome.usage?.output_tokens ?? null,
        billing: billingFor(cfg.backend, outcome.abortedAfterSend, outcome.usage != null),
      });
      const retryable = outcome.http_status === 429 || outcome.http_status === 529;
      if (!retryable || !opts.retry429) break;
      const wait = Math.min(2000, 100 * 2 ** (attempts - 1));
      if (monotonicMs() + wait >= deadline) break;
      await sleep(wait);
    }

    if (attempts === 0 || !last) {
      return {
        status: 'timeout', http_status: null, attempts: 0, judge_http_rtt_ms: null,
        vendor_latency_ms: null, usage: null, billing: 'none', vendor_request_id: null,
        request_hash: rh, client_request_id: clientRequestId, signals: {}, served_model: servedModel,
        errors: ['judge call did not reach the model within the deadline'],
      };
    }

    return {
      status: last.status, http_status: last.http_status, attempts,
      judge_http_rtt_ms: last.rtt, vendor_latency_ms: last.vendor_latency_ms, usage: last.usage,
      billing: billingFor(cfg.backend, last.abortedAfterSend, last.usage != null),
      vendor_request_id: last.vendor_request_id, request_hash: rh, client_request_id: clientRequestId,
      signals: last.signals, served_model: servedModel, errors: last.errors,
    };
  }

  return {
    config: publicConfig,
    describe,
    served: () => servedModel,
    call,
  };
}
