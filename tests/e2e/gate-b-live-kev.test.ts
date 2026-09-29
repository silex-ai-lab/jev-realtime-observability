import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findObjects,
  isObject,
  outcomeRowsForRun,
  startGateAHarness,
  startSandboxRun,
  waitFor,
  waitForDecision,
  waitForEvaluations,
} from '../helpers/harness.ts';
import type { PolicyDecision } from '../../contracts/decision.ts';
import type { EvaluationRecord } from '../../contracts/judge.ts';

const KEV_URL = process.env.KEV_URL;

test('Gate B live Kev scenarios verify outcomes and record experimental semantic signals', { skip: !KEV_URL ? 'set KEV_URL to run live Kev e2e' : false, timeout: 180_000 }, async () => {
  assert.ok(KEV_URL);
  const h = await startGateAHarness({
    judge: {
      backend: 'kev-local',
      baseUrl: KEV_URL,
      model: 'kev-latest',
      expectedRun: 'jaredpalmer/kev-4b',
      maxRps: 10,
      maxInputTokensPerSec: 1_000_000,
      maxResponseBytes: 1_000_000,
    },
    worker: { autostart: true, leaseMs: 30_000, realtimeTtlMs: 60_000 },
  });
  try {
    const s5 = await startSandboxRun(h, 'S5');
    await waitForDecision(h, s5, 'alpha', 30_000);
    await waitForOutcome(h, s5, 'unknown_after_deadline', 45_000);

    const s9 = await startSandboxRun(h, 'S9');
    await waitForDecision(h, s9, 'alpha', 30_000);
    await waitForOutcome(h, s9, 'pending', 20_000);
    await waitForOutcome(h, s9, 'verified_success', 45_000);

    const s7 = await startSandboxRun(h, 'S7');
    const s7Decision = await waitForDecision(h, s7, 'alpha', 30_000);
    const s7Evaluations = await waitForSignal(h, s7, 'goal_deviation');
    assertNoRuleHit(s7Decision, 'S7');
    assert.notEqual(s7Decision.recommended, 'BLOCK', 'S7 should not be blocked by rules');
    assertKevOnly('S7', s7Evaluations);

    const s8 = await startSandboxRun(h, 'S8');
    const s8Decision = await waitForDecision(h, s8, 'alpha', 30_000);
    const s8Evaluations = await waitForSignal(h, s8, 'payee_relation');
    assertNoRuleHit(s8Decision, 'S8');
    assert.notEqual(s8Decision.recommended, 'BLOCK', 'S8 should not be blocked by rules');
    assertKevOnly('S8', s8Evaluations);
  } finally {
    await h.close();
  }
});

async function waitForOutcome(h: Awaited<ReturnType<typeof startGateAHarness>>, runId: string, state: string, timeoutMs: number): Promise<void> {
  await waitFor(async () => {
    const rows = await outcomeRowsForRun(h.db, 't-alpha', runId);
    return rows.some(row => row.state === state) ? rows : null;
  }, `${runId} outcome ${state}`, timeoutMs);
}

async function waitForSignal(h: Awaited<ReturnType<typeof startGateAHarness>>, runId: string, signal: string): Promise<EvaluationRecord[]> {
  return waitFor(async () => {
    const evaluations = await waitForEvaluations(h, runId, 'alpha', 30_000);
    return evaluations.some(evaluation => !!evaluation.signals[signal]) ? evaluations : null;
  }, `${runId} ${signal} signal`, 45_000);
}

function assertNoRuleHit(decision: PolicyDecision, label: string): void {
  assert.ok(decision.rule_results.every(r => r.verdict === 'PASS'), `${label}: expected no rule hit`);
}

function assertKevOnly(label: string, evaluations: EvaluationRecord[]): void {
  for (const evaluation of evaluations) {
    assert.ok(evaluation.judge_source?.startsWith('kev-local:'), `${label}: expected kev-local judge_source, got ${evaluation.judge_source}`);
    const suspicious = findObjects<Record<string, unknown>>(evaluation, v => isObject(v) && Object.values(v).some(x => typeof x === 'string' && /\bjev\b/i.test(x)));
    assert.equal(suspicious.length, 0, `${label}: evaluation payload labels Kev as Jev`);
  }
}
