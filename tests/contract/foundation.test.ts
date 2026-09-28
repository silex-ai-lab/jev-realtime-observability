// T0 acceptance: contracts validate the recorded real Kev fixtures and golden events;
// migrations apply on PGlite; canonical digests are stable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SystemOneRequest, SystemOneResponse, ServedModel, judgeSourceOf } from '../../contracts/judge.ts';
import { BoundaryEvent } from '../../contracts/events.ts';
import { SCHEMA_VERSION } from '../../contracts/common.ts';
import { canonicalJson, digestOf } from '../../contracts/canonical.ts';
import { openDb, migrate } from '../../server/storage/db.ts';

const fx = (p: string) => JSON.parse(readFileSync(new URL(`../../contracts/fixtures/${p}`, import.meta.url), 'utf8'));

test('recorded Kev requests and responses parse against the wire contract', () => {
  for (const n of ['ap', 'score']) {
    SystemOneRequest.parse(fx(`kev/${n}-request.json`));
    const r = SystemOneResponse.parse(fx(`kev/${n}-response.json`));
    assert.ok(Object.keys(r.answers).length >= 2);
  }
});

test('served model identity comes from /v1/models, not the request model name', () => {
  const m = fx('kev/models.json').models[0];
  const served = ServedModel.parse({ backend: 'kev-local', run: m.run, base: m.base, revision: null, temperature: m.temperature, runtime: `${m.backend}/${m.dtype}/${m.device}` });
  assert.equal(judgeSourceOf(served), 'kev-local:jaredpalmer/kev-4b');
  assert.notEqual(judgeSourceOf(served), m.name); // "kev-latest" / "jev-latest" are names, not identity
});

test('golden BoundaryEvent validates; tenant_id in the body is not part of the contract', () => {
  const ev = BoundaryEvent.parse({
    schema_version: SCHEMA_VERSION, event_id: 'ev-1', run_id: 'run-1', trace_id: '0'.repeat(31) + '1',
    producer_id: 'runner-1', producer_seq: 3, boundary: 'pre_tool', occurred_at: new Date(0).toISOString(),
    actor: { kind: 'agent', id: 'ap-agent' },
    operation: { tool: 'payments.execute', operation_id: 'op-1', args: { amount_usd: 10 }, args_digest: digestOf({ amount_usd: 10 }) },
  });
  assert.equal(ev.sources.length, 0);
  assert.equal('tenant_id' in ev, false);
});

test('canonical JSON sorts keys deeply and rejects non-finite numbers', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } }), '{"a":{"c":3,"d":[2,{"y":2,"z":1}]},"b":1}');
  assert.equal(digestOf({ a: 1, b: 2 }), digestOf({ b: 2, a: 1 }));
  assert.throws(() => canonicalJson({ x: Number.NaN }));
});

test('core migrations apply on PGlite and are idempotent', async () => {
  const db = await openDb();
  const first = await migrate(db);
  assert.deepEqual(first, ['core/0001_init.sql']);
  assert.deepEqual(await migrate(db), []);
  const t = await db.query<{ n: number }>(`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema = 'public'`);
  assert.ok(t.rows[0].n >= 17);
  await db.close();
});
