// Records a Gate A demo run (plan §8): every Gate A scenario against a live judge, with the raw
// /v1/systemone responses teed off the real HTTP calls. Output: runs/demo-<date>/.
// All data is fictional sandbox data; keys used here are throwaway and are not written out.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';

const KEV = process.env.KEV_URL ?? 'http://127.0.0.1:8009';
const out = join('runs', `demo-${new Date().toISOString().slice(0, 10)}`);
mkdirSync(out, { recursive: true });

// Tee raw judge traffic (request + response body + measured wall time) without changing it.
const raw: Array<{ at: string; url: string; request: unknown; status: number; response: unknown; wall_ms: number }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(KEV) || !url.endsWith('/v1/systemone')) return realFetch(input, init);
  const t0 = performance.now();
  const res = await realFetch(input, init);
  const body = await res.clone().text();
  let parsed: unknown = body; try { parsed = JSON.parse(body); } catch { /* keep text */ }
  raw.push({ at: new Date().toISOString(), url: '/v1/systemone', request: JSON.parse(String(init?.body ?? 'null')), status: res.status, response: parsed, wall_ms: Math.round(performance.now() - t0) });
  return res;
}) as typeof fetch;

const k = (r: string) => `${r}-demo-record-key-00000000`;
const app = await createApp({
  judge: { backend: 'kev-local', baseUrl: KEV, model: 'kev-latest', expectedRun: 'jaredpalmer/kev-4b', maxRps: 10, maxInputTokensPerSec: 40000, maxResponseBytes: 262144 },
  sourceMode: 'live_sandbox_shadow',
  tenants: [{ tenant_id: 't-demo', name: 'Demo (fictional)', keys: { ingest: k('ingest'), reader: k('reader'), gateway: k('gateway'), admin: k('admin') } }],
  worker: { autostart: true }, web: false,
});
const runs: Array<{ scenario: string; run_id: string; errors: string[] }> = [];
for (const sc of ['S1', 'S2', 'S3', 'S4', 'S6', 'F1']) {
  const r = await app.runScenario('t-demo', sc);
  runs.push({ scenario: sc, ...r });
}
for (let i = 0; i < 300; i++) {
  const p = await app.db.query<{ n: number }>(`SELECT count(*)::int n FROM evaluation_jobs WHERE status IN ('queued','leased')`);
  if (p.rows[0].n === 0) break;
  await new Promise(r => setTimeout(r, 100));
}
const dump = async (sql: string) => (await app.db.query(sql)).rows;
const tables = {
  events: await dump(`SELECT body FROM events ORDER BY received_at, producer_seq`),
  snapshots: await dump(`SELECT body FROM snapshots ORDER BY created_at`),
  evaluations: await dump(`SELECT body FROM evaluations ORDER BY created_at`),
  decisions: await dump(`SELECT body FROM decisions ORDER BY created_at`),
  judge_calls: await dump(`SELECT caller, judge_source, status, http_status, rtt_ms, input_tokens, output_tokens, billing, at FROM judge_calls ORDER BY call_id`),
  outbox: await dump(`SELECT cursor, kind, ref_id, run_id, at FROM outbox ORDER BY cursor`),
  sandbox_ledger: await dump(`SELECT * FROM sandbox.ledger ORDER BY 1`),
  sandbox_mail_sink: await dump(`SELECT * FROM sandbox.mail_sink ORDER BY 1`),
};
for (const [name, rows] of Object.entries(tables)) writeFileSync(join(out, `${name}.json`), JSON.stringify(rows, null, 1));
writeFileSync(join(out, 'judge_raw.json'), JSON.stringify(raw, null, 1));
writeFileSync(join(out, 'runs.json'), JSON.stringify({ judge: app.judge?.served(), runs }, null, 1));
const summary = Object.fromEntries(Object.entries(tables).map(([n, r]) => [n, r.length]));
console.log(JSON.stringify({ out, judge_raw: raw.length, ...summary }));
await app.close();
