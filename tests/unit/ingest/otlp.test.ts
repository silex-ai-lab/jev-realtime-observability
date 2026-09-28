// OTLP/HTTP JSON normalisation: silex-annotated spans become BoundaryEvents; evaluator spans are ignored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseOtlp } from '../../../server/ingest/index.ts';
import { BoundaryEvent } from '../../../contracts/events.ts';

const kv = (key: string, v: string | number) => ({ key, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: v } });
const span = (attrs: ReturnType<typeof kv>[]) => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'pre_tool payments.execute', startTimeUnixNano: '1700000000000000000', attributes: attrs });

test('a silex span maps to a valid BoundaryEvent that shares the SDK source_event_id', () => {
  const body = { resourceSpans: [{ scopeSpans: [{ scope: { name: 'silex.sandbox.runner' }, spans: [span([
    kv('silex.event_id', 'ev-1'), kv('silex.source_event_id', 'ev-1'), kv('silex.boundary', 'pre_tool'), kv('silex.run_id', 'run-1'),
    kv('silex.producer_id', 'p'), kv('silex.producer_seq', 4), kv('silex.actor_kind', 'agent'), kv('silex.actor_id', 'ap-agent'),
    kv('silex.operation', JSON.stringify({ tool: 'erp.get_po', operation_id: 'op-1', args: { po_id: 'PO-1' }, args_digest: 'sha256:' + '0'.repeat(64) })),
  ])] }] }] };
  const { events, ignored } = normaliseOtlp(body);
  assert.equal(ignored, 0);
  const ev = BoundaryEvent.parse(events[0]);
  assert.equal(ev.source_event_id, 'ev-1');
  assert.equal(ev.event_id, 'otlp-ev-1');
  assert.equal(ev.producer_seq, 4);
  assert.equal(ev.occurred_at, new Date(1700000000000).toISOString());
});

test('spans without silex identity, and evaluator self-telemetry, are ignored', () => {
  const body = { resourceSpans: [{ scopeSpans: [
    { scope: { name: 'app' }, spans: [span([kv('http.method', 'GET')])] },
    { scope: { name: 'silex.evaluator' }, spans: [span([kv('silex.event_id', 'x'), kv('silex.boundary', 'pre_tool')])] },
  ] }] };
  const r = normaliseOtlp(body);
  assert.equal(r.events.length, 0); assert.equal(r.ignored, 2);
});
