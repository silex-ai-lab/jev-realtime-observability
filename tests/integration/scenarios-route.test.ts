// F0 of logs/2026-09-29_SUMO_DEMO_PLAN.md: GET /v1/sandbox/scenarios lists the sandbox scenario ids the console
// renders as buttons (AP ids unchanged and first). Reader or admin in keys mode; no key with login off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../server/app.ts';
import { scenarioIds } from '../../sandbox/scenarios/index.ts';

const k = (r: string) => `${r}-scenarios-key-0000000000`;
const tenants = [{ tenant_id: 't-a', name: 'A', keys: { ingest: k('i'), reader: k('r'), gateway: k('g'), admin: k('a') } }];
const AP = ['S1', 'S2', 'S3', 'S4', 'S6', 'S5', 'S7', 'S8', 'S9', 'F1'];

test('login off: the route needs no key and lists the AP scenarios first, unchanged', async () => {
  const app = await createApp({ judge: null, sourceMode: 'live_sandbox_shadow', tenants, worker: { autostart: false }, web: false, mirrorOtlp: false });
  try {
    const r = await fetch(`${app.url}/v1/sandbox/scenarios`);
    assert.equal(r.status, 200);
    const ids = (await r.json() as { scenario_ids: string[] }).scenario_ids;
    assert.deepEqual(ids, scenarioIds());
    assert.deepEqual(ids.slice(0, AP.length).sort(), [...AP].sort());
  } finally { await app.close(); }
});

test("auth: 'keys': reader and admin may list; no key, a wrong key and the ingest key may not", async () => {
  const app = await createApp({ auth: 'keys', judge: null, sourceMode: 'live_sandbox_shadow', tenants, worker: { autostart: false }, web: false, mirrorOtlp: false });
  try {
    const get = (key?: string) => fetch(`${app.url}/v1/sandbox/scenarios`, key ? { headers: { authorization: `Bearer ${key}` } } : {});
    assert.equal((await get()).status, 401);
    assert.equal((await get('wrong-key-0000000000000')).status, 401);
    assert.equal((await get(k('i'))).status, 403);
    assert.equal((await get(k('r'))).status, 200);
    assert.equal((await get(k('a'))).status, 200);
  } finally { await app.close(); }
});
