// A lease shorter than the judge call lets a second slot pick the same job; completion must stay single.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../server/app.ts';
import { startStubJudge } from '../helpers/stub-judge-server.ts';

test('an expired lease never produces two realtime decisions for one event', async () => {
  const stub = await startStubJudge({ respond: (req: { questions: Record<string, { type: string }> }) => ({ status: 200, delayMs: 300, body: {
    model: 'stub', answers: Object.fromEntries(Object.entries(req.questions).map(([q, v]) => [q, v.type === 'noul' ? { type: 'noul', noul: 0.1 }
      : v.type === 'choice' ? { type: 'choice', choice: Object.keys((v as unknown as { criteria: Record<string, unknown> }).criteria)[0], confidence: 0.5,
        probabilities: Object.fromEntries(Object.keys((v as unknown as { criteria: Record<string, unknown> }).criteria).map((o, i, a) => [o, i === 0 ? 1 - (a.length - 1) * 0.1 : 0.1])) }
      : { type: 'score', score: 0, confidence: 0.5, legend: { 0: 'none', 1: 'minor', 2: 'material', 3: 'severe' }, probabilities: { 0: 0.7, 1: 0.1, 2: 0.1, 3: 0.1 } }])) } }) } as never);
  const k = (r: string) => `${r}-lease-test-key-0000000`;
  const app = await createApp({ judge: { backend: 'stub', baseUrl: stub.url, model: 'stub', maxRps: 50, maxInputTokensPerSec: 1e6, maxResponseBytes: 1 << 20 },
    sourceMode: 'live_sandbox_shadow', tenants: [{ tenant_id: 't-l', name: 'L', keys: { ingest: k('i'), reader: k('r'), gateway: k('g'), admin: k('a') } }],
    worker: { autostart: true, leaseMs: 20, concurrency: 2 }, web: false, mirrorOtlp: false });
  try {
    const run = await app.runScenario('t-l', 'S1');
    for (let i = 0; i < 100; i++) {
      const pending = await app.db.query<{ n: number }>(`SELECT count(*)::int n FROM evaluation_jobs WHERE status IN ('queued','leased') AND kind = 'realtime'`);
      if (pending.rows[0].n === 0) break;
      await new Promise(r => setTimeout(r, 100));
    }
    const dup = await app.db.query<{ event_id: string; n: number }>(
      `SELECT event_id, count(*)::int n FROM decisions WHERE replay_of IS NULL AND event_id IN (SELECT event_id FROM events WHERE run_id = $1) GROUP BY 1 HAVING count(*) > 1`, [run.run_id]);
    assert.deepEqual(dup.rows, []);
  } finally { await app.close(); await stub.close(); }
});
