// Capture SDK (RFC §3.1 observation path, §9.2). Posts boundary events straight to /v1/events
// (the agent never waits for evaluation), and can mirror each event as an OTLP span through the
// official OpenTelemetry SDK. Both carry the same source_event_id, so the server counts it once.
import { randomBytes, randomUUID } from 'node:crypto';
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { Tracer } from '@opentelemetry/api';
import { SCHEMA_VERSION, type Boundary } from '../contracts/common.ts';
import type { BoundaryEvent, BoundaryEventInput, SourceExcerpt } from '../contracts/events.ts';
import { digestOf } from '../contracts/canonical.ts';
import type { PreflightResponse } from '../contracts/preflight.ts';

export interface CaptureOptions {
  baseUrl: string;
  apiKey: string;               // ingest-role key; never logged
  producerId: string;
  runId: string;
  mirrorOtlp?: boolean;
}

export interface Capture {
  readonly runId: string;
  readonly traceId: string;
  emit(boundary: Boundary, fields: Partial<Omit<BoundaryEventInput, 'schema_version' | 'boundary' | 'run_id' | 'trace_id' | 'producer_id' | 'producer_seq'>>): Promise<BoundaryEvent>;
  operation(tool: string, args: Record<string, unknown>): { tool: string; operation_id: string; args: Record<string, unknown>; args_digest: string };
  /** Gate C: synchronous pre-tool control. Records the pre_tool event and returns a bound ControlDecision. */
  preflight(op: { tool: string; operation_id: string; args: Record<string, unknown>; args_digest: string }, opts?: { sources?: SourceExcerpt[]; tool_call_id?: string; attributes?: Record<string, string | number | boolean> }): Promise<{ response: PreflightResponse; sdk_preflight_ms: number }>;
  close(): Promise<void>;
}

export function createCapture(o: CaptureOptions): Capture {
  let seq = 0;
  const traceId = randomBytes(16).toString('hex');
  let provider: BasicTracerProvider | null = null, tracer: Tracer | null = null;
  if (o.mirrorOtlp) {
    provider = new BasicTracerProvider({
      resource: resourceFromAttributes({ 'service.name': 'silex-sandbox-runner' }),
      spanProcessors: [new SimpleSpanProcessor(new OTLPTraceExporter({ url: `${o.baseUrl}/v1/traces`, headers: { authorization: `Bearer ${o.apiKey}` } }))],
    });
    tracer = provider.getTracer('silex.sandbox.runner');
  }

  async function post(ev: BoundaryEvent) {
    const r = await fetch(`${o.baseUrl}/v1/events`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}` }, body: JSON.stringify(ev) });
    if (r.status !== 202) throw new Error(`capture rejected: HTTP ${r.status}`);
  }

  function mirror(ev: BoundaryEvent) {
    if (!tracer) return;
    const attrs: Record<string, string | number> = {
      'silex.event_id': ev.event_id, 'silex.source_event_id': ev.source_event_id ?? ev.event_id, 'silex.boundary': ev.boundary,
      'silex.run_id': ev.run_id, 'silex.producer_id': ev.producer_id, 'silex.producer_seq': ev.producer_seq,
      'silex.actor_kind': ev.actor.kind, 'silex.actor_id': ev.actor.id,
    };
    if (ev.task_goal) attrs['silex.task_goal'] = ev.task_goal;
    if (ev.tool_call_id) attrs['silex.tool_call_id'] = ev.tool_call_id;
    if (ev.operation) attrs['silex.operation'] = JSON.stringify(ev.operation);
    if (ev.result) attrs['silex.result'] = JSON.stringify(ev.result);
    if (ev.text) attrs['silex.text'] = ev.text;
    if (ev.sources.length) attrs['silex.sources'] = JSON.stringify(ev.sources);
    for (const [k, v] of Object.entries(ev.attributes)) attrs[k] = typeof v === 'boolean' ? String(v) : v;
    const span = tracer.startSpan(`${ev.boundary}${ev.operation ? ' ' + ev.operation.tool : ''}`, { attributes: attrs });
    span.end();
  }

  return {
    runId: o.runId,
    traceId,
    async emit(boundary, f) {
      const id = `ev-${randomUUID()}`;
      const ev: BoundaryEvent = {
        schema_version: SCHEMA_VERSION, event_id: id, source_event_id: id, run_id: o.runId, trace_id: traceId,
        span_id: randomBytes(8).toString('hex'), producer_id: o.producerId, producer_seq: seq++, boundary,
        occurred_at: new Date().toISOString(), actor: f.actor ?? { kind: 'agent', id: o.producerId },
        tool_call_id: f.tool_call_id, task_goal: f.task_goal, operation: f.operation, result: f.result, text: f.text,
        sources: (f.sources ?? []) as SourceExcerpt[], attributes: f.attributes ?? {},
      };
      await post(ev);
      mirror(ev);
      return ev;
    },
    async preflight(op, opts = {}) {
      const t0 = performance.now();
      const id = `ev-${randomUUID()}`;
      const body = { schema_version: SCHEMA_VERSION, event_id: id, run_id: o.runId, trace_id: traceId, producer_id: o.producerId, producer_seq: seq++,
        actor: { kind: 'agent' as const, id: o.producerId }, operation: op, tool_call_id: opts.tool_call_id, sources: opts.sources ?? [], attributes: opts.attributes ?? {} };
      const r = await fetch(`${o.baseUrl}/v1/preflight`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}` }, body: JSON.stringify(body) });
      if (r.status !== 200) throw new Error(`preflight rejected: HTTP ${r.status}`);
      const response = await r.json() as PreflightResponse;
      const sdkMs = performance.now() - t0;
      // The preflight recorded the pre_tool event; mirror it to OTLP like any emitted event (same source_event_id → dedup).
      mirror({ ...body, source_event_id: id, boundary: 'pre_tool', occurred_at: new Date().toISOString(), span_id: randomBytes(8).toString('hex') } as BoundaryEvent);
      return { response, sdk_preflight_ms: sdkMs };
    },
    operation(tool, args) {
      return { tool, operation_id: `op-${randomUUID()}`, args, args_digest: digestOf(args) };
    },
    async close() { await provider?.forceFlush(); await provider?.shutdown(); },
  };
}
