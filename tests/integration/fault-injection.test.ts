// FAULT_INJECTION is off by default (plan D6 / T2). F1's `fault: judge_timeout` shortens the judge
// budget to 1 ms only when the deployment enables it, on both the shadow worker and the gate preflight.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../server/app.ts';
import { appOptionsFromEnv } from '../../server/config.ts';
import type { JudgeConfig } from '../../server/judges/index.ts';
import type { SystemOneRequest } from '../../contracts/judge.ts';
import { argsDigest } from '../../sandbox/index.ts';
import { SCHEMA_VERSION } from '../../contracts/common.ts';
import {
  harnessFromApp, makeBoundaryEvent, postEventOk, runWorker, startStubJudge, waitForDecision, TENANTS,
} from '../helpers/harness.ts';

const stub = (url: string): JudgeConfig => ({
  backend: 'stub', baseUrl: url, model: 'kev-latest', expectedRun: 'stub',
  maxRps: 100, maxInputTokensPerSec: 1_000_000, maxResponseBytes: 1_000_000,
});

/** A valid answer for every asked question, delayed so a 1 ms budget deterministically aborts. */
function respondWithDelay(delayMs: number) {
  return (req: unknown) => {
    const r = req as SystemOneRequest;
    const answers: Record<string, unknown> = {};
    for (const [qid, q] of Object.entries(r.questions)) {
      if (q.type === 'noul') answers[qid] = { type: 'noul', noul: 0.1 };
      else if (q.type === 'choice') {
        const keys = Object.keys(q.criteria);
        answers[qid] = { type: 'choice', choice: keys[0], probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 1 : 0])) };
      } else {
        const levels = q.criteria;
        answers[qid] = { type: 'score', score: 0, legend: Object.fromEntries(levels.map((c, i) => [String(i), c])), probabilities: Object.fromEntries(levels.map((_, i) => [String(i), i === 0 ? 1 : 0])) };
      }
    }
    return { status: 200, body: { model: r.model, answers, usage: { input_tokens: 1, output_tokens: 1 } }, delayMs };
  };
}

async function shadowDecision(faultInjection: boolean | undefined) {
  const judge = await startStubJudge({ respond: respondWithDelay(50) });
  const app = await createApp({
    judge: stub(judge.url), sourceMode: 'live_sandbox_shadow', auth: 'keys',
    tenants: [...TENANTS], worker: { autostart: false }, ...(faultInjection === undefined ? {} : { faultInjection }),
  });
  const h = harnessFromApp(app, null);
  try {
    const event = makeBoundaryEvent({ attributes: { fault: 'judge_timeout' } });
    await postEventOk(h, event);
    await runWorker(h);
    return await waitForDecision(h, event.run_id);
  } finally {
    await h.close();
    await judge.close();
  }
}

async function gateBudget(faultInjection: boolean | undefined) {
  const judge = await startStubJudge();
  const app = await createApp({
    judge: stub(judge.url), sourceMode: 'live_sandbox_gate', auth: 'keys',
    tenants: [...TENANTS], worker: { autostart: false }, ...(faultInjection === undefined ? {} : { faultInjection }),
  });
  const h = harnessFromApp(app, null);
  try {
    const args = { invoice_id: 'INV-7731', po_id: 'PO-4410', amount_usd: 8420, payee: 'Pacific Paper Co.', account_ref: 'ACCT-118-01', remit_domain: 'bank.northwind.example' };
    const body = {
      schema_version: SCHEMA_VERSION,
      event_id: `evt-${crypto.randomUUID()}`,
      run_id: `run-${crypto.randomUUID()}`,
      trace_id: '0123456789abcdef0123456789abcdef',
      producer_id: 'fault-test-wrapper',
      producer_seq: 1,
      actor: { kind: 'agent', id: 'agent-ap' },
      operation: { tool: 'payments.execute', operation_id: `op-${crypto.randomUUID()}`, args, args_digest: argsDigest(args) },
      sources: [],
      attributes: { fault: 'judge_timeout' },
    };
    const resp = await h.request('POST', '/v1/preflight', { tenant: 'alpha', role: 'ingest', body });
    const text = await resp.text();
    assert.equal(resp.status, 200, text);
    return JSON.parse(text) as { timings: { judge_budget_ms: number } };
  } finally {
    await h.close();
    await judge.close();
  }
}

test('shadow worker: FAULT_INJECTION off leaves the judge budget intact', async () => {
  const d = await shadowDecision(false);
  assert.notEqual(d.decided_by, 'judge_unavailable', `expected a real answer, got ${d.decided_by}: ${d.reasons.join('; ')}`);
  assert.equal(d.recommended, 'NO_CONFIGURED_RISK');
});

test('shadow worker: FAULT_INJECTION on shortens the judge budget to a fault', async () => {
  const d = await shadowDecision(true);
  assert.equal(d.decided_by, 'judge_unavailable');
  assert.equal(d.recommended, 'HOLD');
});

test('gate preflight: FAULT_INJECTION off leaves the judge budget intact', async () => {
  const r = await gateBudget(false);
  assert.ok(r.timings.judge_budget_ms > 1, `budget was shortened to ${r.timings.judge_budget_ms}`);
});

test('gate preflight: FAULT_INJECTION on shortens the judge budget to 1 ms', async () => {
  const r = await gateBudget(true);
  assert.equal(r.timings.judge_budget_ms, 1);
});

test('createApp default (option omitted): neither the worker nor preflight injects the fault', async () => {
  const d = await shadowDecision(undefined);
  assert.notEqual(d.decided_by, 'judge_unavailable', `worker injected the fault by default: ${d.reasons.join('; ')}`);
  const r = await gateBudget(undefined);
  assert.ok(r.timings.judge_budget_ms > 1, `preflight shortened the budget by default to ${r.timings.judge_budget_ms}`);
});

test('env: FAULT_INJECTION defaults off; =1 enables it', () => {
  const saved = { ...process.env };
  try {
    delete process.env.FAULT_INJECTION;
    process.env.JUDGE_BACKEND = 'none';
    assert.equal(appOptionsFromEnv().faultInjection, false);
    process.env.FAULT_INJECTION = '1';
    assert.equal(appOptionsFromEnv().faultInjection, true);
    process.env.FAULT_INJECTION = '0';
    assert.equal(appOptionsFromEnv().faultInjection, false);
  } finally {
    process.env = saved;
  }
});
