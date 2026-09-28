// Ingest (RFC §5.2, §9.1, §9.2): authenticated boundary events and OTLP/HTTP JSON spans.
// An accepted event is persisted together with its evaluation job in one transaction, then 202.
import { BoundaryEvent, type StoredEvent } from '../../contracts/events.ts';
import { MANIFEST } from '../state/index.ts';
import { EVALUATED_BOUNDARIES, SCHEMA_VERSION, type Boundary } from '../../contracts/common.ts';
import { digestOf } from '../../contracts/canonical.ts';
import type { Db } from '../storage/db.ts';
import * as repos from '../storage/repos.ts';

export interface IngestResult { event_id: string; status: 'inserted' | 'duplicate' | 'conflict' | 'invalid'; error?: string }

export interface IngestDeps { db: Db; realtimeTtlMs: number; notify: () => void }

/** Validates, derives server fields, persists event + job atomically. Never trusts a body tenant_id. */
export async function ingestEvents(deps: IngestDeps, tenantId: string, raw: unknown[], path: 'sdk' | 'otlp'): Promise<IngestResult[]> {
  const out: IngestResult[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object' && 'tenant_id' in item) {
      out.push({ event_id: String((item as { event_id?: unknown }).event_id ?? ''), status: 'invalid', error: 'tenant_id is derived from the credential and must not be sent' });
      continue;
    }
    const parsed = BoundaryEvent.safeParse(item);
    if (!parsed.success) {
      out.push({ event_id: String((item as { event_id?: unknown })?.event_id ?? ''), status: 'invalid', error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
      continue;
    }
    const ev = parsed.data;
    const contentDigest = eventContentDigest(ev);
    // Args are redacted per the tool registry before storage; args_digest (over the full args) is kept (CONTRACTS §2).
    const stored: StoredEvent = { ...redactEvent(ev), tenant_id: tenantId, received_at: new Date().toISOString(), ingest_path: path };
    const evaluate = EVALUATED_BOUNDARIES.includes(ev.boundary);
    const status = await deps.db.tx(async q => {
      const s = await repos.insertEventWithJob(q, stored, contentDigest,
        evaluate ? { kind: 'realtime', priority: 100, not_after: new Date(Date.now() + deps.realtimeTtlMs).toISOString() } : null);
      if (s === 'inserted') {
        if (ev.boundary === 'run_started') {
          await repos.upsertRun(q, { tenant_id: tenantId, run_id: ev.run_id, driver: String(ev.attributes.driver ?? 'unknown'),
            scenario: ev.attributes.scenario != null ? String(ev.attributes.scenario) : null, provenance: { source: path } });
        }
        if (ev.boundary === 'run_finished') await repos.finishRun(q, tenantId, ev.run_id, ev.attributes.status === 'failed' ? 'failed' : 'finished');
        await repos.appendOutbox(q, { tenant_id: tenantId, kind: 'event', ref_id: ev.event_id, run_id: ev.run_id, payload: publicEvent(stored) });
      } else if (s === 'conflict') {
        await repos.audit(q, tenantId, 'ingest', 'event_conflict', { event_id: ev.event_id, source_event_id: ev.source_event_id ?? null });
      }
      return s;
    });
    out.push({ event_id: ev.event_id, status });
  }
  if (out.some(r => r.status === 'inserted')) deps.notify();
  return out;
}

/**
 * Digest of everything an event asserts, excluding only transport-specific fields that legitimately differ
 * between an SDK event and its OTLP mirror (event_id, source_event_id, trace/span ids, schema_version,
 * occurred_at). Same id + any other difference → conflict (RFC §5.2, §9.1). Attribute values are compared
 * as strings because OTLP carries booleans as strings.
 */
export function eventContentDigest(ev: BoundaryEvent): string {
  return digestOf({
    run_id: ev.run_id, producer_id: ev.producer_id, producer_seq: ev.producer_seq, boundary: ev.boundary,
    actor: ev.actor, task_goal: ev.task_goal ?? null, tool_call_id: ev.tool_call_id ?? null,
    operation: ev.operation ?? null, result: ev.result ?? null, text: ev.text ?? null, sources: ev.sources ?? [],
    attributes: Object.fromEntries(Object.entries(ev.attributes ?? {}).map(([k, v]) => [k, String(v)])),
  });
}

export function redactEvent(ev: BoundaryEvent): BoundaryEvent {
  if (!ev.operation) return ev;
  const reg = MANIFEST.tool_registry[ev.operation.tool];
  const redact = reg ? reg.redact_args : Object.keys(ev.operation.args);   // unknown tool: store no arg values
  if (!redact.length) return ev;
  const args = Object.fromEntries(Object.entries(ev.operation.args).map(([k, v]) => [k, redact.includes(k) ? '[redacted]' : v]));
  return { ...ev, operation: { ...ev.operation, args } };
}

/** The event as streamed to the UI: no args values beyond the redacted set already stored. */
export function publicEvent(e: StoredEvent): Record<string, unknown> {
  return {
    event_id: e.event_id, run_id: e.run_id, trace_id: e.trace_id, span_id: e.span_id ?? null, boundary: e.boundary,
    producer_id: e.producer_id, producer_seq: e.producer_seq, occurred_at: e.occurred_at, received_at: e.received_at,
    ingest_path: e.ingest_path, actor: e.actor, tool: e.operation?.tool ?? null, operation_id: e.operation?.operation_id ?? null,
    result_status: e.result?.status ?? null, task_goal: e.task_goal ?? null, attributes: e.attributes,
  };
}

// ---- OTLP/HTTP JSON (protobuf-JSON mapping of ExportTraceServiceRequest) ------------------
type AnyValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean };
type KeyValue = { key: string; value: AnyValue };
interface OtlpSpan { traceId: string; spanId: string; parentSpanId?: string; name: string; startTimeUnixNano: string; attributes?: KeyValue[] }
interface OtlpRequest { resourceSpans?: Array<{ scopeSpans?: Array<{ scope?: { name?: string }; spans?: OtlpSpan[] }> }> }

const val = (v: AnyValue | undefined): string | number | boolean | undefined =>
  v?.stringValue ?? (v?.intValue != null ? Number(v.intValue) : undefined) ?? v?.doubleValue ?? v?.boolValue;
// OTLP JSON ids are hex strings; some exporters send base64. Accept both.
const hexId = (s: string | undefined, len: number) => {
  if (!s) return undefined;
  if (new RegExp(`^[0-9a-f]{${len}}$`, 'i').test(s)) return s.toLowerCase();
  const b = Buffer.from(s, 'base64').toString('hex');
  return b.length === len ? b : undefined;
};

/**
 * Maps spans carrying `silex.event_id` + `silex.boundary` (+ silex.* fields) to BoundaryEvents.
 * Spans of scope `silex.evaluator` are ignored so the evaluator never evaluates itself (RFC §13).
 */
export function normaliseOtlp(body: unknown): { events: unknown[]; ignored: number } {
  const req = body as OtlpRequest;
  const events: unknown[] = [];
  let ignored = 0;
  for (const rs of req.resourceSpans ?? []) for (const ss of rs.scopeSpans ?? []) {
    if (ss.scope?.name === 'silex.evaluator') { ignored += ss.spans?.length ?? 0; continue; }
    for (const sp of ss.spans ?? []) {
      const a = Object.fromEntries((sp.attributes ?? []).map(kv => [kv.key, val(kv.value)]));
      if (typeof a['silex.event_id'] !== 'string' || typeof a['silex.boundary'] !== 'string') { ignored++; continue; }
      const attrs: Record<string, string | number | boolean> = {};
      for (const [k, v] of Object.entries(a)) if (!k.startsWith('silex.') && v !== undefined) attrs[k] = v;
      const json = (k: string) => { try { return typeof a[k] === 'string' ? JSON.parse(a[k] as string) : undefined; } catch { return undefined; } };
      events.push({
        schema_version: SCHEMA_VERSION,
        event_id: `otlp-${a['silex.event_id']}`,
        source_event_id: a['silex.source_event_id'] ?? a['silex.event_id'],
        run_id: a['silex.run_id'],
        trace_id: hexId(sp.traceId, 32),
        span_id: hexId(sp.spanId, 16),
        parent_span_id: hexId(sp.parentSpanId, 16),
        producer_id: a['silex.producer_id'],
        producer_seq: a['silex.producer_seq'],
        boundary: a['silex.boundary'] as Boundary,
        occurred_at: new Date(Number(BigInt(sp.startTimeUnixNano) / 1_000_000n)).toISOString(),
        tool_call_id: a['silex.tool_call_id'],
        actor: { kind: a['silex.actor_kind'] ?? 'agent', id: a['silex.actor_id'] ?? 'agent' },
        task_goal: a['silex.task_goal'],
        operation: json('silex.operation'),
        result: json('silex.result'),
        text: a['silex.text'],
        sources: json('silex.sources') ?? [],
        attributes: attrs,
      });
    }
  }
  return { events, ignored };
}
