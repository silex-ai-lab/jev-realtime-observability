// E1: OTLP/HTTP export of decisions (docs/CONTRACTS.md §11.6). One span per decision, whose
// attributes come only from the §11.6 allowlist and only when known. Text, source excerpts, judge_view,
// operation args, reasons and evidence are never exported. The export is a bounded async queue (drop the
// oldest when full, with a drop counter; per-request timeout; bounded retries) and never runs on the
// decision path: a committed decision is exported fire-and-forget.
import { sha256 } from '../../contracts/canonical.ts';

/** The only attribute keys ever placed on an exported span (docs/CONTRACTS.md §11.6). */
export const EXPORT_ATTRIBUTE_KEYS = [
  'silex.decision_id', 'silex.run_id', 'silex.event_id', 'silex.tool', 'silex.boundary',
  'silex.recommended', 'silex.decided_by', 'silex.rules', 'silex.control_action', 'silex.receipt_status',
  'silex.signals', 'silex.judge_source', 'silex.policy_version',
] as const;

const str = (v: unknown): string | null =>
  v == null ? null : (typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean' ? String(v) : null));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** `rule_results` → "rule_id:verdict,..." (reason and evidence are never exported). */
function rulesValue(decision: Record<string, unknown>): string | null {
  const rr = decision.rule_results;
  if (!Array.isArray(rr) || rr.length === 0) return null;
  const parts = rr.map(r => {
    if (!isRecord(r)) return null;
    const id = str(r.rule_id); const verdict = str(r.verdict);
    return id != null && verdict != null ? `${id}:${verdict}` : null;
  }).filter((x): x is string => x != null);
  return parts.length ? parts.join(',') : null;
}

/** `semantic.hits` → "question_id:value,..." (value is the raw probability for noul risk questions). */
function signalsValue(decision: Record<string, unknown>): string | null {
  const semantic = decision.semantic;
  const hits = isRecord(semantic) ? semantic.hits : null;
  if (!Array.isArray(hits) || hits.length === 0) return null;
  const parts = hits.map(h => {
    if (!isRecord(h)) return null;
    const qid = str(h.question_id);
    const value = h.value;
    return qid != null && value != null ? `${qid}:${String(value)}` : null;
  }).filter((x): x is string => x != null);
  return parts.length ? parts.join(',') : null;
}

function judgeSourceOf(decision: Record<string, unknown>): string | null {
  const p = decision.provenance;
  return isRecord(p) ? str(p.judge_source) : null;
}

/** Builds the allowlist attribute set (flat key → string) from a committed decision record. */
export function decisionSpanAttributes(decision: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (key: string, value: string | null): void => { if (value != null && value !== '') out[key] = value; };
  set('silex.decision_id', str(decision.decision_id));
  set('silex.run_id', str(decision.run_id));
  set('silex.event_id', str(decision.event_id));
  set('silex.tool', str(decision.tool));
  set('silex.boundary', str(decision.boundary));
  set('silex.recommended', str(decision.recommended));
  set('silex.decided_by', str(decision.decided_by));
  set('silex.rules', rulesValue(decision));
  set('silex.control_action', str(decision.control_action));
  set('silex.receipt_status', str(decision.receipt_status));
  set('silex.signals', signalsValue(decision));
  set('silex.judge_source', judgeSourceOf(decision));
  set('silex.policy_version', str(decision.policy_version));
  return out;
}

const hexOf = (s: string, n: number): string => sha256(s).slice('sha256:'.length, 'sha256:'.length + n);

function spanFor(decision: Record<string, unknown>): Record<string, unknown> {
  const attrs = decisionSpanAttributes(decision);
  const decisionId = str(decision.decision_id) ?? 'unknown-decision';
  const runId = str(decision.run_id) ?? decisionId;
  const createdMs = decision.created_at != null ? Date.parse(String(decision.created_at)) : NaN;
  const ns = Math.floor((Number.isFinite(createdMs) ? createdMs : Date.now()) * 1_000_000);
  const attributes = Object.entries(attrs).map(([key, value]) => ({ key, value: { stringValue: value } }));
  return {
    traceId: hexOf(runId, 32),
    spanId: hexOf(decisionId, 16),
    name: 'silex.decision',
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: String(ns),
    endTimeUnixNano: String(ns),
    attributes,
  };
}

/** A single OTLP/HTTP JSON `ExportTraceServiceRequest` carrying exactly the given spans. */
export function exportTraceServiceRequest(spans: unknown[]): string {
  return JSON.stringify({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: 'silex.decision-export' }, spans }] }] });
}

export interface OtlpDecisionExporterOptions {
  url: string;
  /** Optional extra request headers (e.g. OTLP_EXPORT_HEADERS auth). */
  headers?: Record<string, string>;
  /** Bounded queue size; when full, the oldest pending span is dropped (and counted). */
  queueSize?: number;
  /** Per-request timeout in ms (a collector that never responds cannot stall the pump). */
  requestTimeoutMs?: number;
  /** Number of retries after the first attempt (0 = a single attempt). */
  retries?: number;
  logger?: (msg: string) => void;
}

export interface OtlpDecisionExporter {
  /** Enqueue a decision for export. Never throws, never blocks; drops the oldest span when full. */
  export(decision: Record<string, unknown>): void;
  /** Spans dropped because the queue was full. */
  dropped(): number;
  /** Decisions accepted into the queue. */
  enqueued(): number;
  /** Stops accepting new decisions and flushes the queue (bounded by the per-request timeout). */
  close(): Promise<void>;
}

export function createOtlpDecisionExporter(opts: OtlpDecisionExporterOptions): OtlpDecisionExporter {
  const queueSize = opts.queueSize != null && opts.queueSize > 0 ? opts.queueSize : 1024;
  const timeoutMs = opts.requestTimeoutMs ?? 2_000;
  const retries = opts.retries ?? 2;
  const queue: Record<string, unknown>[] = [];
  let droppedCount = 0;
  let enqueuedCount = 0;
  let closed = false;
  let processing = false;

  const log = (msg: string): void => { opts.logger?.(msg); };

  async function post(body: string): Promise<void> {
    let last: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(opts.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
          body,
          signal: controller.signal,
        });
        if (res.ok) return;
        last = new Error(`collector returned HTTP ${res.status}`);
      } catch (e) {
        last = e;
      } finally {
        clearTimeout(timer);
      }
    }
    log(`otlp decision export failed after ${retries + 1} attempt(s): ${last instanceof Error ? last.message : String(last)}`);
  }

  async function pump(): Promise<void> {
    if (processing) return;
    processing = true;
    try {
      while (queue.length) {
        const decision = queue.shift()!;
        await post(exportTraceServiceRequest([spanFor(decision)]));
      }
    } finally {
      processing = false;
    }
  }

  return {
    export(decision) {
      if (closed) return;
      enqueuedCount++;
      if (queue.length >= queueSize) {
        queue.shift();       // drop the oldest pending span
        droppedCount++;
      }
      queue.push(decision);
      void pump().catch(() => {});
    },
    dropped: () => droppedCount,
    enqueued: () => enqueuedCount,
    async close() {
      if (closed) return;
      closed = true;
      while (processing) await new Promise(r => setTimeout(r, 5));   // wait for the in-flight pump to drain
      while (queue.length) {
        const decision = queue.shift()!;
        await post(exportTraceServiceRequest([spanFor(decision)]));
      }
    },
  };
}
