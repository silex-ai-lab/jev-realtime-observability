import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countJudgeCalls,
  makeBoundaryEvent,
  postEventOk,
  runWorker,
  startGateAHarness,
  startStubJudge,
  waitForDecision,
} from '../helpers/harness.ts';
import type { PolicyDecision } from '../../contracts/decision.ts';
import { digestOf } from '../../contracts/canonical.ts';
import { DEFAULT_POLICY } from '../../server/policy/index.ts';

test('hard-rule decisions are invariant to policy threshold sweeps in policy-only replay', async () => {
  const judge = await startStubJudge();
  const h = await startGateAHarness({
    judge: {
      backend: 'stub',
      baseUrl: judge.url,
      model: 'kev-latest',
      expectedRun: 'stub-kev',
      maxRps: 100,
      maxInputTokensPerSec: 1_000_000,
      maxResponseBytes: 1_000_000,
    },
  });
  try {
    const args = {
      invoice_id: 'INV-8120',
      po_id: 'PO-4502',
      amount_usd: 48000,
      payee: 'Cascade Hardware Inc.',
      account_ref: 'ACCT-311-02',
      remit_domain: 'bank.northwind.example',
    };
    const event = makeBoundaryEvent({
      task_goal: 'Pay invoice INV-8120 for hardware under PO-4502.',
      operation: {
        tool: 'payments.execute',
        operation_id: `op-${crypto.randomUUID()}`,
        args,
        args_digest: digestOf(args),
      },
      sources: [],
    });
    await postEventOk(h, event);
    await runWorker(h);
    const original = await waitForDecision(h, event.run_id);
    assert.equal(original.decided_by, 'rule');
    assert.match(original.recommended, /^(BLOCK|STOP|HOLD)$/);

    const thresholds = [0, 0.05, 0.25, 0.5, 0.75, 0.95, 1];
    for (const threshold of thresholds) {
      const response = await h.request('POST', '/v1/replays', {
        tenant: 'alpha',
        role: 'reader',
        body: {
          kind: 'policy_only',
          decision_ids: [original.decision_id],
          policy: {
            ...DEFAULT_POLICY,
            policy_version: `draft-threshold-${threshold}`,
            semantic: {
              ...DEFAULT_POLICY.semantic,
              bands: Object.fromEntries(
                Object.entries(DEFAULT_POLICY.semantic.bands).map(([qid, band]) => [qid, { ...band, review_at: threshold }]),
              ),
            },
          },
        },
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const replay = JSON.parse(text) as {
        results?: Array<{ after?: Pick<PolicyDecision, 'decision_id' | 'decided_by' | 'recommended' | 'semantic'>; error?: string }>;
      };
      assert.ok(replay.results?.length, `replay at ${threshold} should return a result`);
      for (const result of replay.results) {
        assert.ok(!result.error, `replay at ${threshold} returned ${result.error}`);
        assert.equal(result.after?.decided_by, original.decided_by, `decided_by changed at ${threshold}`);
        assert.equal(result.after?.recommended, original.recommended, `recommendation changed at ${threshold}`);
      }
    }
  } finally {
    await h.close();
    await judge.close();
  }
});

test('policy-only replay makes zero judge calls', async () => {
  const judge = await startStubJudge();
  const h = await startGateAHarness({
    judge: {
      backend: 'stub',
      baseUrl: judge.url,
      model: 'kev-latest',
      expectedRun: 'stub-kev',
      maxRps: 100,
      maxInputTokensPerSec: 1_000_000,
      maxResponseBytes: 1_000_000,
    },
  });
  try {
    const event = makeBoundaryEvent();
    await postEventOk(h, event);
    await runWorker(h);
    const decision = await waitForDecision(h, event.run_id);
    const beforeDb = await countJudgeCalls(h.db);
    const beforeStub = judge.calls.length;

    const response = await h.request('POST', '/v1/replays', {
      tenant: 'alpha',
      role: 'reader',
      body: {
        kind: 'policy_only',
        decision_ids: [decision.decision_id],
        policy: {
          ...DEFAULT_POLICY,
          policy_version: 'draft-zero-call',
          semantic: {
            ...DEFAULT_POLICY.semantic,
            bands: {
              ...DEFAULT_POLICY.semantic.bands,
              instruction_override: { ...DEFAULT_POLICY.semantic.bands.instruction_override, review_at: 0.01 },
            },
          },
        },
      },
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const afterDb = await countJudgeCalls(h.db);
    assert.equal(afterDb, beforeDb, 'judge_calls table changed during policy-only replay');
    assert.equal(judge.calls.length, beforeStub, 'stub judge received a policy-only replay call');
  } finally {
    await h.close();
    await judge.close();
  }
});
