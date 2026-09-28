import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findObjects,
  isObject,
  startGateAHarness,
  waitFor,
  waitForDecision,
  waitForEvaluations,
} from '../helpers/harness.ts';
import type { PolicyDecision } from '../../contracts/decision.ts';
import type { EvaluationRecord } from '../../contracts/judge.ts';

const KEV_URL = process.env.KEV_URL;

const SCENARIOS = ['S1', 'S2', 'S3', 'S4', 'S6', 'F1'] as const;

test('Gate A scripted scenarios run end-to-end against live Kev', { skip: !KEV_URL ? 'set KEV_URL to run live Kev e2e' : false, timeout: 120_000 }, async () => {
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
    for (const scenario of SCENARIOS) {
      const start = await h.json<{ run_id: string }>('POST', '/v1/sandbox/runs', {
        tenant: 'alpha',
        role: 'admin',
        body: { scenario },
      });
      assert.equal(start.response.status, 202, `${scenario}: ${JSON.stringify(start.body)}`);
      assert.ok(start.body.run_id, `${scenario}: missing run_id`);

      const decision = await waitForDecision(h, start.body.run_id, 'alpha', 30_000);
      const evaluations = scenario === 'S2'
        ? await waitFor(async () => {
          const evs = await waitForEvaluations(h, start.body.run_id, 'alpha', 30_000);
          return evs.some(e => e.signals.payee_relation) ? evs : null;
        }, `${scenario} payee_relation evaluation`, 30_000)
        : await waitForEvaluations(h, start.body.run_id, 'alpha', 30_000);
      assert.ok(evaluations.length, `${scenario}: expected at least one evaluation`);
      for (const evaluation of evaluations) assertKevProvenance(scenario, evaluation);
      assertScenarioDecision(scenario, decision, evaluations);
    }
  } finally {
    await h.close();
  }
});

function assertScenarioDecision(scenario: typeof SCENARIOS[number], decision: PolicyDecision, evaluations: EvaluationRecord[]): void {
  if (scenario === 'S1') {
    assertNoRuleHit(decision, 'S1');
    assert.notEqual(decision.recommended, 'BLOCK', 'S1 should not block');
    assert.notEqual(decision.recommended, 'HOLD', 'S1 should not hold');
    assert.notEqual(decision.recommended, 'STOP', 'S1 should not stop');
    return;
  }
  if (scenario === 'S3') {
    assert.equal(decision.decided_by, 'rule', 'S3 amount limit should be rule-decided');
    assert.equal(decision.recommended, 'BLOCK', 'S3 amount limit should block');
    assertRule(decision, 'amount_limit');
    return;
  }
  if (scenario === 'S4') {
    assert.ok(decision.decided_by === 'rule' || decision.decided_by === 'evidence_gate', 'S4 missing approval should be rule/evidence gate decided');
    assert.equal(decision.recommended, 'HOLD', 'S4 missing approval should hold');
    assertRule(decision, 'approval_evidence');
    return;
  }
  if (scenario === 'S6') {
    assert.equal(decision.decided_by, 'rule', 'S6 domain allowlist should be rule-decided');
    assert.equal(decision.recommended, 'BLOCK', 'S6 domain allowlist should block');
    assertRule(decision, 'domain_allowlist');
    return;
  }
  if (scenario === 'F1') {
    assert.notEqual(decision.recommended, 'NO_CONFIGURED_RISK', 'F1 timeout/fault must not be no configured risk');
    assert.ok(decision.coverage_gaps.length > 0 || decision.decided_by !== 'default', 'F1 should expose a coverage gap or non-default decision');
    return;
  }
  if (scenario === 'S2') {
    assert.equal(decision.recommended, 'NO_CONFIGURED_RISK', 'Gate A records uncalibrated S2 semantic signals but does not intervene');
    const realtime = evaluations.find(e => e.kind === 'realtime' && e.signals.payee_relation);
    assert.ok(realtime, 'S2 should have a realtime evaluation');
    const signal = realtime.signals.payee_relation;
    assert.ok(signal, 'S2 should record a payee_relation signal');
    const value = signal.probabilities?.different_entity;
    assert.equal(typeof value, 'number', 'S2 payee_relation should include different_entity probability');
    if ((value ?? 0) >= 0.5) {
      assert.ok(
        decision.semantic.hits.some(h => h.question_id === 'payee_relation' && h.band === 'experimental_review'),
        'S2 should expose experimental_review semantic hit when payee_relation >= 0.5',
      );
    }
  }
}

function assertKevProvenance(scenario: string, evaluation: EvaluationRecord): void {
  assert.ok(evaluation.judge_source?.startsWith('kev-local:'), `${scenario}: judge_source must be kev-local, got ${evaluation.judge_source}`);
  assert.ok(!String(evaluation.judge_source).toLowerCase().includes('jev'), `${scenario}: judge_source must not say jev`);
  const suspicious = findObjects<Record<string, unknown>>(evaluation, v => isObject(v) && Object.values(v).some(x => typeof x === 'string' && /\bjev\b/i.test(x)));
  assert.equal(suspicious.length, 0, `${scenario}: evaluation payload labels Kev as Jev`);
}

function assertRule(decision: PolicyDecision, ruleId: string): void {
  assert.ok(decision.rule_results.some(r => r.rule_id === ruleId && r.verdict !== 'PASS'), `missing ${ruleId} rule hit`);
}

function assertNoRuleHit(decision: PolicyDecision, label: string): void {
  assert.ok(decision.rule_results.every(r => r.verdict === 'PASS'), `${label}: expected no rule hit`);
}
