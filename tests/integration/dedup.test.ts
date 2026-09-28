// RFC §5.2 / §9.1: an SDK event and its OTLP mirror (real OpenTelemetry exporter) are stored once;
// the same event id with any changed content is a 409 conflict, not a silent duplicate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../server/app.ts';
import { createCapture } from '../../sdk/index.ts';
import { SCHEMA_VERSION } from '../../contracts/common.ts';

const k = (r: string) => `${r}-dedup-test-key-00000000`;
async function withApp(fn: (app: Awaited<ReturnType<typeof createApp>>) => Promise<void>) {
  const app = await createApp({ judge: null, sourceMode: 'live_sandbox_shadow', web: false,
    tenants: [{ tenant_id: 't-d', name: 'D', keys: { ingest: k('i'), reader: k('r'), gateway: k('g'), admin: k('a') } }], worker: { autostart: false } });
  try { await fn(app); } finally { await app.close(); }
}
const post = (app: { url: string }, body: unknown) => fetch(`${app.url}/v1/events`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${k('i')}` }, body: JSON.stringify(body) });

test('SDK events mirrored through the real OTLP exporter are stored once each', async () => withApp(async app => {
  const cap = createCapture({ baseUrl: app.url, apiKey: k('i'), producerId: 'p', runId: 'run-dedup', mirrorOtlp: true });
  await cap.emit('run_started', { actor: { kind: 'user', id: 'u' }, task_goal: 'Pay INV-1.', attributes: { driver: 'test', flag: true } });
  const op = cap.operation('vendor.lookup', { vendor_id: 'V-118' });
  await cap.emit('pre_tool', { operation: op, tool_call_id: 'call-1' });
  await cap.emit('post_tool', { operation: op, tool_call_id: 'call-1', result: { status: 'ok', http_status: 200, body: { vendor: 'x' } },
    sources: [{ id: 's1', producer: 'sandbox.erp', authenticity: 'verified', instruction_authority: 'none', excerpt: 'note' }] });
  await cap.close();
  const n = await app.db.query<{ path: string; n: number }>(`SELECT ingest_path path, count(*)::int n FROM events GROUP BY 1`);
  assert.deepEqual(n.rows, [{ path: 'sdk', n: 3 }], 'mirrors must dedup; nothing may be stored twice');
  const conflicts = await app.db.query<{ n: number }>(`SELECT count(*)::int n FROM audit_log WHERE action = 'event_conflict'`);
  assert.equal(conflicts.rows[0].n, 0, 'a faithful mirror is never a conflict');
}));

test('same event id with changed task_goal, sources, result body or attributes → 409', async () => withApp(async app => {
  const base = { schema_version: SCHEMA_VERSION, event_id: 'ev-c1', run_id: 'run-c', trace_id: 'a'.repeat(32), producer_id: 'p', producer_seq: 1,
    boundary: 'post_tool', occurred_at: new Date().toISOString(), actor: { kind: 'agent', id: 'a' }, task_goal: 'goal',
    result: { status: 'ok', body: { x: 1 } }, sources: [{ id: 's', producer: 'erp', authenticity: 'verified', instruction_authority: 'none', excerpt: 'e' }], attributes: { a: 1 } };
  assert.equal((await post(app, base)).status, 202);
  assert.equal((await post(app, { ...base, occurred_at: new Date(Date.now() + 5).toISOString() })).status, 202, 'transport timestamp differences are not conflicts');
  for (const [name, change] of [
    ['task_goal', { task_goal: 'another goal' }],
    ['sources', { sources: [{ ...base.sources[0], excerpt: 'changed evidence' }] }],
    ['result body', { result: { status: 'ok', body: { x: 2 } } }],
    ['attributes', { attributes: { a: 2 } }],
  ] as const) {
    const r = await post(app, { ...base, ...change });
    assert.equal(r.status, 409, `changed ${name} must conflict`);
  }
  const stored = await app.db.query<{ n: number }>(`SELECT count(*)::int n FROM events WHERE event_id = 'ev-c1'`);
  assert.equal(stored.rows[0].n, 1);
}));

test('args are redacted before storage per the tool registry; the digest still covers the full args', async () => withApp(async app => {
  const cap = createCapture({ baseUrl: app.url, apiKey: k('i'), producerId: 'p', runId: 'run-r' });
  const op = cap.operation('email.send', { to: 'a@northwind.example', subject: 's', body: 'secret body text', includes_fields: [] });
  await cap.emit('pre_tool', { operation: op });
  await cap.close();
  const row = await app.db.query<{ body: { operation: { args: Record<string, unknown>; args_digest: string } } }>(`SELECT body FROM events WHERE run_id = 'run-r'`);
  assert.equal(row.rows[0].body.operation.args.body, '[redacted]');
  assert.equal(row.rows[0].body.operation.args_digest, op.args_digest);
  const dump = JSON.stringify((await app.db.query(`SELECT * FROM events`)).rows);
  assert.ok(!dump.includes('secret body text'));
}));
