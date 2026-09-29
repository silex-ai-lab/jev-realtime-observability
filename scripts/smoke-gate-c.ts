// Planner smoke for Gate C: gate mode against live Kev (gate judge Kev-0.8B, whose p50 fits the 400 ms judge budget).
import { createApp } from '../server/app.ts';
const kev = (url: string, run: string) => ({ backend: 'kev-local' as const, baseUrl: url, model: 'kev-latest', expectedRun: run, maxRps: 10, maxInputTokensPerSec: 40000, maxResponseBytes: 262144 });
const k = (r: string) => `${r}-smoke-c-key-00000000000`;
const app = await createApp({ judge: process.env.NO_SHADOW_JUDGE ? null : kev('http://127.0.0.1:8009', 'jaredpalmer/kev-4b'), gateJudge: kev('http://127.0.0.1:8010', 'jaredpalmer/kev-0.8b'),
  sourceMode: 'live_sandbox_gate', tenants: [{ tenant_id: 't-c', name: 'C', keys: { ingest: k('i'), reader: k('r'), gateway: k('g'), admin: k('a') } }], worker: { autostart: true }, web: false });
const scs = (process.argv[2] ?? 'S1,S2,S3,S4,S6,F1,S7').split(',');
for (const sc of scs) {
  const r = await app.runScenario('t-c', sc);
  const rows = await app.db.query<{ tool: string; a: Record<string, string> }>(`SELECT body->'operation'->>'tool' tool, body->'attributes' a FROM events WHERE run_id = $1 AND boundary = 'post_tool' ORDER BY producer_seq`, [r.run_id]);
  const ledger = await app.db.query<{ n: number }>(`SELECT count(*)::int n FROM sandbox.ledger l JOIN execution_receipts x ON x.operation_id = l.operation_id WHERE x.body->>'control_id' IN (SELECT control_id FROM control_decisions WHERE body->>'run_id' = $1)`, [r.run_id]);
  const decs = await app.db.query<{ rec: string; by: string; reasons: string[] }>(`SELECT d.body->>'recommended' rec, d.body->>'decided_by' by, d.body->'reasons' reasons FROM decisions d JOIN control_decisions c ON c.body->>'snapshot_id' = d.body->>'snapshot_id' WHERE c.body->>'run_id' = $1`, [r.run_id]);
  console.log(`${sc.padEnd(3)} ${rows.rows.map(x => `${x.tool}: control=${x.a.control_action ?? '(read, ungated)'} receipt=${x.a.receipt_status}${x.a.sdk_preflight_ms ? ` preflight=${x.a.sdk_preflight_ms}ms` : ''}`).join(' | ')} · ledger rows under control: ${ledger.rows[0].n}`);
  for (const d of decs.rows) console.log(`      decision ${d.rec} by ${d.by}${d.reasons.length ? ' — ' + d.reasons[0].slice(0, 110) : ''}`);
}
const m = await (await fetch(`${app.url}/v1/metrics`, { headers: { authorization: `Bearer ${k('r')}` } })).json();
console.log('\nmetrics.gate:', JSON.stringify(m.gate));
if (process.env.RECORD) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const dir = 'runs/gate-smoke-2026-09-28'; mkdirSync(dir, { recursive: true });
  const rows = (await app.db.query(`SELECT c.body->>'run_id' run_id, c.body->>'tool' tool, c.body->>'action' control_action, x.body->>'status' receipt, d.body->>'recommended' recommended, d.body->>'decided_by' decided_by, (e.body->'attributes'->>'sdk_preflight_ms')::int sdk_preflight_ms
    FROM control_decisions c JOIN execution_receipts x ON x.body->>'control_id' = c.control_id JOIN decisions d ON d.body->>'snapshot_id' = c.body->>'snapshot_id'
    LEFT JOIN events e ON e.boundary = 'post_tool' AND e.body->'attributes'->>'control_id' = c.control_id ORDER BY c.created_at`)).rows;
  writeFileSync(`${dir}/${process.env.RECORD}.json`, JSON.stringify({ config: { shadow_judge: process.env.NO_SHADOW_JUDGE ? 'none' : 'kev-4b on the same GPU', extra_load: process.env.LOAD ?? 'none', gate_judge: 'kev-0.8b', scenarios: scs }, gate_metrics: m.gate, controls: rows }, null, 1));
  console.log(`recorded ${dir}/${process.env.RECORD}.json`);
}
await app.close();
