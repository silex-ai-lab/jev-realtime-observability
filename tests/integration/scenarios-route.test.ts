// F0 of logs/2026-09-29_SUMO_DEMO_PLAN.md: GET /v1/sandbox/scenarios lists the sandbox scenario ids the console
// renders as buttons (AP ids unchanged and first). Reader or admin in keys mode; no key with login off.
// A1 of logs/2026-09-30_CONSOLE_UX_PLAN.md: the route also returns scenario metadata and tool impacts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../server/app.ts';
import { SCENARIOS, scenarioIds } from '../../sandbox/scenarios/index.ts';

const k = (r: string) => `${r}-scenarios-key-0000000000`;
const tenants = [{ tenant_id: 't-a', name: 'A', keys: { ingest: k('i'), reader: k('r'), gateway: k('g'), admin: k('a') } }];
const AP = ['S1', 'S2', 'S3', 'S4', 'S6', 'S5', 'S7', 'S8', 'S9', 'F1'];

interface ScenariosBody {
  scenario_ids: string[];
  scenarios: Array<{ id: string; title: string; domain: string }>;
  tools: Record<string, string>;
  unknown_tool_impact: string;
  source_mode: string;
}

test('login off: the route needs no key and lists the AP scenarios first, unchanged', async () => {
  const app = await createApp({ judge: null, sourceMode: 'live_sandbox_shadow', tenants, worker: { autostart: false }, web: false, mirrorOtlp: false });
  try {
    const r = await fetch(`${app.url}/v1/sandbox/scenarios`);
    assert.equal(r.status, 200);
    const body = await r.json() as ScenariosBody;
    assert.deepEqual(body.scenario_ids, scenarioIds());
    assert.deepEqual(body.scenario_ids.slice(0, AP.length).sort(), [...AP].sort());
    // scenario metadata, in the same order, with id/title/domain (domain defaults to 'ap')
    assert.deepEqual(body.scenarios, SCENARIOS.map(s => ({ id: s.id, title: s.title, domain: s.domain ?? 'ap' })));
    assert.deepEqual(body.scenarios.map(s => s.id), body.scenario_ids);
    // tool impacts from the registry, and the unknown-tool fallback
    assert.equal(body.tools['siem.search'], 'read');
    assert.equal(body.tools['webhook.post'], 'write');
    assert.equal(body.unknown_tool_impact, 'payment');
    assert.equal(body.source_mode, 'live_sandbox_shadow', 'the console learns the mode before the first decision');
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
    // both roles see the full shape (scenarios, tools, unknown_tool_impact)
    for (const key of [k('r'), k('a')]) {
      const r = await get(key);
      const body = await r.json() as ScenariosBody;
      assert.deepEqual(body.scenario_ids, scenarioIds());
      assert.deepEqual(body.scenarios, SCENARIOS.map(s => ({ id: s.id, title: s.title, domain: s.domain ?? 'ap' })));
      assert.equal(body.tools['siem.search'], 'read');
      assert.equal(body.tools['webhook.post'], 'write');
      assert.equal(body.unknown_tool_impact, 'payment');
    }
  } finally { await app.close(); }
});
