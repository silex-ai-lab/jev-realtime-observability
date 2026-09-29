// Planner smoke for Gate B scenarios against live Kev: decisions, signals and outcome states over time.
import { createApp } from '../server/app.ts';
import * as repos from '../server/storage/repos.ts';
const KEV = process.env.KEV_URL ?? 'http://127.0.0.1:8009';
const k = (r: string) => `${r}-smoke-b-key-00000000000`;
const app = await createApp({ judge: { backend: 'kev-local', baseUrl: KEV, model: 'kev-latest', expectedRun: 'jaredpalmer/kev-4b', maxRps: 10, maxInputTokensPerSec: 40000, maxResponseBytes: 262144 },
  sourceMode: 'live_sandbox_shadow', tenants: [{ tenant_id: 't-b', name: 'B', keys: { ingest: k('i'), reader: k('r'), gateway: k('g'), admin: k('a') } }], worker: { autostart: true }, web: false });
const runs: Record<string, string> = {};
for (const sc of (process.argv[2] ?? 'S5,S7,S8,S9').split(',')) runs[sc] = (await app.runScenario('t-b', sc)).run_id;
for (const t of [2, 6, 13]) {
  await new Promise(r => setTimeout(r, t === 2 ? 2000 : t === 6 ? 4000 : 7000));
  const oc = await app.db.query<{ run_id: string; tool: string; state: string }>(`SELECT run_id, tool, state FROM outcome_checks ORDER BY run_id`);
  console.log(`t≈${t}s outcomes:`, oc.rows.map(r => `${Object.entries(runs).find(([, v]) => v === r.run_id)?.[0]}:${r.tool}=${r.state}`).join('  '));
}
for (const [sc, runId] of Object.entries(runs)) {
  console.log(`\n=== ${sc}`);
  for (const e of await repos.listRunEvents(app.db, 't-b', runId, null, 100)) {
    for (const d of await repos.listDecisionsForEvent(app.db, 't-b', e.event_id)) {
      const ev = (await repos.listEvaluationsForEvent(app.db, 't-b', e.event_id)).find(x => x.kind === 'realtime');
      const sig = ev ? Object.entries(ev.signals).map(([q, s]) => `${q}=${s.type === 'noul' ? s.raw_probability?.toFixed(3) : s.type === 'choice' ? `${s.choice}(${s.probabilities?.[s.choice!]?.toFixed(2)})` : s.score?.toFixed(2)}`).join(' ') : '';
      console.log(`  ${e.boundary.padEnd(15)} ${(e.operation?.tool ?? '').padEnd(16)} → ${d.recommended.padEnd(18)} ${d.decided_by.padEnd(10)} ${sig}`);
      for (const r of d.reasons.filter(x => /outcome|claim|uncalibrated/.test(x))) console.log(`      · ${r}`);
    }
  }
}
console.log('\nmetrics:', JSON.stringify(await (await fetch(`${app.url}/v1/metrics`, { headers: { authorization: `Bearer ${k('r')}` } })).json()));
await app.close();
