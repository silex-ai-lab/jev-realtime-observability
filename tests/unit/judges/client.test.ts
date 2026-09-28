// JudgeClient tests over the real HTTP path via the stub server: deadline/abort, 429 retry,
// body cap, model identity, ledger rows, and the canary api-key invariant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createJudgeClient, mapServedModel, requestHash } from '../../../server/judges/index.ts';
import type { JudgeLedgerRow, JudgeCallOptions } from '../../../server/judges/index.ts';
import { startStubJudge } from '../../helpers/stub-judge-server.ts';
import type { SystemOneRequest } from '../../../contracts/judge.ts';

const fx = (p: string) => JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/${p}`, import.meta.url), 'utf8'));
const apReq = fx('kev/ap-request.json') as SystemOneRequest;
const apRes = fx('kev/ap-response.json');

const opts = (over: Partial<JudgeCallOptions> = {}): JudgeCallOptions =>
  ({ tenantId: 't-alpha', evaluationId: 'eval-1', caller: 'realtime', deadlineMs: 5000, retry429: true, ...over });

function client(baseUrl: string, cfg: Partial<Parameters<typeof createJudgeClient>[0]> = {}) {
  const rows: JudgeLedgerRow[] = [];
  const c = createJudgeClient({
    backend: 'stub', baseUrl, model: 'stub-latest', maxRps: 100, maxInputTokensPerSec: 1_000_000, maxResponseBytes: 1_000_000,
    ...cfg,
  }, { ledger: async row => { rows.push(row); } });
  return { c, rows };
}

test('mapServedModel maps Kev /v1/models shape; revision is null when underivable', () => {
  const m = fx('kev/models.json').models[0];
  const served = mapServedModel('kev-local', m);
  assert.equal(served?.backend, 'kev-local');
  assert.equal(served?.run, 'jaredpalmer/kev-4b');
  assert.equal(served?.base, 'Qwen/Qwen3.5-4B-Base');
  assert.equal(served?.revision, null);
  assert.equal(served?.temperature, 2.406050072164233);
  assert.equal(served?.runtime, 'mlx/bfloat16/mps');
});

test('requestHash is canonical and key-order independent', () => {
  const a = { model: 'm', state: 's', questions: { q: { type: 'noul', instructions: 'i' } } } as unknown as SystemOneRequest;
  const b = { questions: { q: { type: 'noul', instructions: 'i' } }, model: 'm', state: 's' } as unknown as SystemOneRequest;
  assert.equal(requestHash(a), requestHash(b));
  assert.match(requestHash(a), /^sha256:[0-9a-f]{64}$/);
});

test('happy path: one attempt, ledger row, validated signals', async () => {
  const judge = await startStubJudge({ respond: () => ({ status: 200, body: apRes }) });
  try {
    const { c, rows } = client(judge.url);
    const r = await c.call(apReq, ['payee_relation', 'goal_deviation'], opts());
    assert.equal(r.status, 'ok');
    assert.equal(r.attempts, 1);
    assert.ok(r.signals['payee_relation']);
    assert.ok(r.judge_http_rtt_ms != null && r.judge_http_rtt_ms >= 0);
    assert.equal(judge.calls.length, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'ok');
    assert.equal(rows[0].billing, 'none');   // stub backend is neither metered nor local compute
  } finally {
    await judge.close();
  }
});

test('429 with retry429 retries within the deadline; without retry it is rate_limited', async () => {
  let n = 0;
  const judge = await startStubJudge({ respond: () => (++n === 1 ? { status: 429, body: { error: 'slow down' } } : { status: 200, body: apRes }) });
  try {
    const { c, rows } = client(judge.url);
    const ok = await c.call(apReq, ['payee_relation'], opts());
    assert.equal(ok.status, 'ok');
    assert.equal(ok.attempts, 2);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].status, 'rate_limited');
  } finally { await judge.close(); }

  let m = 0;
  const judge2 = await startStubJudge({ respond: () => (++m === 1 ? { status: 429, body: { error: 'no' } } : { status: 200, body: apRes }) });
  try {
    const { c, rows } = client(judge2.url);
    const r = await c.call(apReq, ['payee_relation'], opts({ retry429: false }));
    assert.equal(r.status, 'rate_limited');
    assert.equal(r.attempts, 1);
    assert.equal(rows.length, 1);
  } finally { await judge2.close(); }
});

test('deadline abort after send → timeout with billing unknown', async () => {
  const judge = await startStubJudge({ respond: () => ({ status: 200, body: apRes, delayMs: 10_000 }) });
  try {
    const { c, rows } = client(judge.url);
    const r = await c.call(apReq, ['payee_relation'], opts({ deadlineMs: 50, retry429: false }));
    assert.equal(r.status, 'timeout');
    assert.equal(r.billing, 'unknown');
    assert.equal(r.attempts, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].billing, 'unknown');
  } finally { await judge.close(); }
});

test('model_mismatch when expectedRun differs; no /v1/systemone attempt is made', async () => {
  const judge = await startStubJudge();  // reports run 'stub'
  try {
    const { c, rows } = client(judge.url, { expectedRun: 'something-else' });
    const r = await c.call(apReq, ['payee_relation'], opts());
    assert.equal(r.status, 'model_mismatch');
    assert.equal(r.attempts, 0);
    assert.equal(judge.calls.length, 0);
    assert.equal(rows.length, 0);
  } finally { await judge.close(); }
});

test('body size cap turns an oversized response into invalid_response', async () => {
  const judge = await startStubJudge({ respond: () => ({ status: 200, body: { model: 'stub', answers: { x: 'y'.repeat(10_000) } } }) });
  try {
    const { c } = client(judge.url, { maxResponseBytes: 100 });
    const r = await c.call(apReq, ['payee_relation'], opts());
    assert.equal(r.status, 'invalid_response');
    assert.ok(r.errors.some(e => e.includes('exceeded')));
  } finally { await judge.close(); }
});

test('describe() returns the served model; served() caches it', async () => {
  const judge = await startStubJudge();
  try {
    const { c } = client(judge.url);
    const s = await c.describe();
    assert.equal(s?.backend, 'stub');
    assert.equal(s?.run, 'stub');
    assert.equal(c.served()?.backend, 'stub');
  } finally { await judge.close(); }
});

test('the api key never appears in errors, results, config or ledger (canary)', async () => {
  const CANARY = 'silex-canary-judge-key-DO-NOT-LEAK';
  const judge = await startStubJudge({ respond: () => ({ status: 500, body: { error: 'upstream failed' } }) });
  try {
    const { c, rows } = client(judge.url, { apiKey: CANARY });
    const r = await c.call(apReq, ['payee_relation'], opts({ retry429: false }));
    assert.equal(r.status, 'http_error');
    assert.ok(!JSON.stringify(r).includes(CANARY), 'result leaks api key');
    assert.ok(!JSON.stringify(r.errors).includes(CANARY), 'errors leak api key');
    assert.ok(!JSON.stringify(rows).includes(CANARY), 'ledger leaks api key');
    assert.ok(!('apiKey' in c.config), 'config exposes apiKey');
    assert.ok(!JSON.stringify(c.config).includes(CANARY));
  } finally { await judge.close(); }
});
