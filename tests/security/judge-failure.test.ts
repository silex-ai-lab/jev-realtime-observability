import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeBoundaryEvent,
  postEventOk,
  runWorker,
  startGateAHarness,
  startStubJudge,
  waitForDecision,
  waitForEvaluations,
} from '../helpers/harness.ts';

const JUDGE_FAILURES = [
  { name: '500', response: { status: 500, body: { error: 'boom' } } },
  { name: 'timeout', response: { status: 200, body: { model: 'kev-latest', answers: {} }, delayMs: 10_000 } },
  { name: 'invalid JSON', response: { status: 200, body: 'not-json' } },
] as const;

for (const scenario of JUDGE_FAILURES) {
  test(`judge ${scenario.name} on pre_tool payment is degraded, not semantically safe`, async () => {
    const judge = await startStubJudge({ respond: () => scenario.response });
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
      worker: { autostart: true, leaseMs: 50, realtimeTtlMs: 500 },
    });
    try {
      const event = makeBoundaryEvent();
      await postEventOk(h, event);
      await runWorker(h);

      const evaluations = await waitForEvaluations(h, event.run_id);
      assert.ok(evaluations.some(e => e.status !== 'ok'), 'failure should produce a non-ok evaluation status');

      const decision = await waitForDecision(h, event.run_id);
      assert.notEqual(decision.decided_by, 'semantic', 'missing judge answer must not be treated as a semantic allow');
      assert.notEqual(decision.recommended, 'NO_CONFIGURED_RISK', 'missing judge answer must not be safe');
      assert.ok(decision.coverage_gaps.length > 0 || decision.decided_by === 'judge_unavailable', 'coverage gap or judge_unavailable decision required');
    } finally {
      await h.close();
      await judge.close();
    }
  });
}
