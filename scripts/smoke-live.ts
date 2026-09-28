// Planner smoke: every Gate A scenario end to end against a live judge (KEV_URL). Prints the record.
import { createApp } from '../server/app.ts';
import * as repos from '../server/storage/repos.ts';

const KEV = process.env.KEV_URL ?? 'http://127.0.0.1:8009';
const k = (r: string) => `${r}-smoke-key-000000000000`;
const app = await createApp({
  judge: { backend: 'kev-local', baseUrl: KEV, model: 'kev-latest', expectedRun: 'jaredpalmer/kev-4b', maxRps: 10, maxInputTokensPerSec: 40000, maxResponseBytes: 262144 },
  sourceMode: 'live_sandbox_shadow',
  tenants: [{ tenant_id: 't-smoke', name: 'Smoke', keys: { ingest: k('ingest'), reader: k('reader'), gateway: k('gateway'), admin: k('admin') } }],
  worker: { autostart: false }, web: false,
});
console.log('judge served:', JSON.stringify(app.judge?.served()));
for (const sc of (process.argv[2] ?? 'S1,S2,S3,S4,S6,F1').split(',')) {
  const t0 = performance.now();
  const run = await app.runScenario('t-smoke', sc);
  await new Promise(r => setTimeout(r, 300));          // let the OTLP mirror land
  await app.worker.drain();
  const events = await repos.listRunEvents(app.db, 't-smoke', run.run_id, null, 200);
  console.log(`\n=== ${sc} ${run.run_id} errors=${JSON.stringify(run.errors)} events=${events.length} (${Math.round(performance.now() - t0)} ms)`);
  for (const e of events) {
    const ds = await repos.listDecisionsForEvent(app.db, 't-smoke', e.event_id);
    const evs = await repos.listEvaluationsForEvent(app.db, 't-smoke', e.event_id);
    if (!ds.length && !evs.length) { console.log(`  ${e.boundary.padEnd(15)} ${e.operation?.tool ?? ''} ${e.ingest_path} ${e.result ? 'result=' + e.result.status + '/' + e.result.http_status : ''}`); continue; }
    for (const d of ds) console.log(`  ${e.boundary.padEnd(15)} ${(e.operation?.tool ?? '').padEnd(17)} → ${d.recommended.padEnd(18)} by ${d.decided_by.padEnd(17)} would_have=${d.would_have} i2s=${Math.round(d.timings.ingest_to_signal_ms ?? -1)}ms rtt=${Math.round(d.timings.judge_http_rtt_ms ?? -1)}ms${d.reasons.length ? '\n      reasons: ' + d.reasons.join(' | ') : ''}`);
    for (const ev of evs) console.log(`      eval ${ev.kind} ${ev.status} ${ev.judge_source} ${Object.entries(ev.signals).map(([q, s]) => `${q}=${s.type === 'noul' ? s.raw_probability?.toFixed(3) : s.choice + '(' + s.probabilities?.[s.choice!]?.toFixed(3) + ')'}`).join(' ')}${ev.errors.length ? ' errors=' + ev.errors.join(';') : ''}`);
  }
}
const calls = await app.db.query<{ caller: string; status: string; n: number }>(`SELECT caller, status, count(*)::int n FROM judge_calls GROUP BY 1,2 ORDER BY 1,2`);
console.log('\njudge_calls ledger:', JSON.stringify(calls.rows));
const dup = await app.db.query<{ n: number }>(`SELECT count(*)::int n FROM events WHERE ingest_path = 'otlp'`);
console.log('otlp events stored (should be 0: all mirrors dedup):', dup.rows[0].n);
await app.close();
