// W2 of logs/2026-09-30_CONSOLE_UX_PLAN.md r7: POST /v1/sandbox/reexec ("Run again") is its own admin route,
// so it works with login off (the /v1/replays reader path would 403 login-off callers). Same logic as
// /v1/replays kind sandbox_reexec: a new run, the original untouched. Both auth modes plus the unknown-run 404.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../server/app.ts';
import { findObjects, harnessFromApp, isObject, startSandboxRun, startStubJudge, TENANTS, waitFor, waitForDecision } from '../helpers/harness.ts';
import type { JudgeConfig } from '../../server/judges/index.ts';
import type { Db } from '../../server/storage/db.ts';

const T = 't-alpha';
const stub = (url: string): JudgeConfig => ({
  backend: 'stub', baseUrl: url, model: 'kev-latest', expectedRun: 'stub',
  maxRps: 100, maxInputTokensPerSec: 1_000_000, maxResponseBytes: 1_000_000,
});

async function decisionsForRun(db: Db, runId: string): Promise<Array<{ decision_id: string; body: unknown }>> {
  const r = await db.query<{ decision_id: string; body: unknown }>(
    `SELECT d.decision_id, d.body FROM decisions d JOIN events e ON e.tenant_id = d.tenant_id AND e.event_id = d.event_id
      WHERE d.tenant_id = $1 AND e.run_id = $2 AND d.replay_of IS NULL ORDER BY d.decision_id`,
    [T, runId],
  );
  return r.rows;
}

/** Resolves once the run's run_finished event has landed, so every decision of the run is stored. */
async function waitForRunFinished(h: ReturnType<typeof harnessFromApp>, runId: string): Promise<void> {
  await waitFor(async () => {
    const { response, body } = await h.json('GET', `/v1/runs/${encodeURIComponent(runId)}`, { tenant: 'alpha', role: 'reader' });
    if (response.status !== 200) return null;
    return findObjects(body, v => isObject(v) && v.boundary === 'run_finished').length ? true : null;
  }, `run ${runId} finished`, 15_000);
}

test('login off: re-executing a run returns 202 with a new run id and leaves the original decisions unchanged', async () => {
  const judge = await startStubJudge();
  const app = await createApp({
    judge: stub(judge.url), sourceMode: 'live_sandbox_shadow', tenants: [...TENANTS],
    worker: { autostart: true, leaseMs: 30_000, realtimeTtlMs: 60_000 }, web: false,
  });
  const h = harnessFromApp(app, null);
  try {
    const runId = await startSandboxRun(h, 'S1');
    await waitForDecision(h, runId, 'alpha', 15_000);
    await waitForRunFinished(h, runId);
    const before = await decisionsForRun(h.db, runId);
    assert.ok(before.length > 0, 'the original run has decisions');

    const { response, body } = await h.json<{ run_id?: string }>('POST', '/v1/sandbox/reexec', { body: { run_id: runId } });
    assert.equal(response.status, 202, JSON.stringify(body));
    assert.equal(typeof body.run_id, 'string', 'must return a new run_id');
    assert.notEqual(body.run_id, runId);

    await waitForDecision(h, body.run_id!, 'alpha', 15_000);
    assert.deepEqual(await decisionsForRun(h.db, runId), before, 'the original run\'s decisions are unchanged');
  } finally {
    await h.close();
    await judge.close();
  }
});

test("auth: 'keys': reader may not re-execute (403), admin may (202)", async () => {
  const judge = await startStubJudge();
  const app = await createApp({
    auth: 'keys', judge: stub(judge.url), sourceMode: 'live_sandbox_shadow', tenants: [...TENANTS],
    worker: { autostart: true, leaseMs: 30_000, realtimeTtlMs: 60_000 }, web: false,
  });
  const h = harnessFromApp(app, null);
  try {
    const runId = await startSandboxRun(h, 'S1');
    await waitForDecision(h, runId, 'alpha', 15_000);

    const reader = await h.request('POST', '/v1/sandbox/reexec', { tenant: 'alpha', role: 'reader', body: { run_id: runId } });
    assert.equal(reader.status, 403, await reader.text());

    const admin = await h.json<{ run_id?: string }>('POST', '/v1/sandbox/reexec', { tenant: 'alpha', role: 'admin', body: { run_id: runId } });
    assert.equal(admin.response.status, 202, JSON.stringify(admin.body));
    assert.equal(typeof admin.body.run_id, 'string');
    assert.notEqual(admin.body.run_id, runId);
  } finally {
    await h.close();
    await judge.close();
  }
});

test('an unknown run id is a 404', async () => {
  const app = await createApp({
    judge: null, sourceMode: 'live_sandbox_shadow', tenants: [...TENANTS],
    worker: { autostart: false }, web: false,
  });
  const h = harnessFromApp(app, null);
  try {
    const res = await h.request('POST', '/v1/sandbox/reexec', { body: { run_id: 'run-does-not-exist' } });
    assert.equal(res.status, 404, await res.text());
  } finally {
    await h.close();
  }
});
