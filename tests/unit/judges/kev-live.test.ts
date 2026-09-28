// Opt-in: exercises the production client against a live Kev server. Skipped unless KEV_URL is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createJudgeClient } from '../../../server/judges/index.ts';
import type { SystemOneRequest } from '../../../contracts/judge.ts';

const KEV_URL = process.env.KEV_URL;
const fx = (p: string) => JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/${p}`, import.meta.url), 'utf8'));
const apReq = fx('kev/ap-request.json') as SystemOneRequest;

test('live Kev describe + call through the production client', { skip: KEV_URL ? false : 'set KEV_URL to run the live Kev opt-in test' }, async () => {
  const rows: unknown[] = [];
  const client = createJudgeClient({
    backend: 'kev-local', baseUrl: KEV_URL!, model: 'kev-latest', expectedRun: 'jaredpalmer/kev-4b',
    maxRps: 10, maxInputTokensPerSec: 1_000_000, maxResponseBytes: 1_000_000,
  }, { ledger: async row => { rows.push(row); } });

  const served = await client.describe();
  assert.equal(served?.backend, 'kev-local');
  assert.equal(served?.run, 'jaredpalmer/kev-4b');
  assert.equal(served?.base, 'Qwen/Qwen3.5-4B-Base');
  assert.equal(served?.revision, null);

  const r = await client.call(apReq, ['payee_relation', 'goal_deviation'], {
    tenantId: 't-alpha', evaluationId: 'eval-live', caller: 'eval', deadlineMs: 30_000, retry429: true,
  });
  assert.ok(r.status === 'ok' || r.status === 'partial', `live Kev status ${r.status}: ${r.errors.join('; ')}`);
  assert.ok(r.signals['payee_relation']);
  assert.equal(r.billing, 'local_compute');
  assert.ok(r.usage && r.usage.input_tokens != null);
  assert.equal(rows.length, 1);
});
