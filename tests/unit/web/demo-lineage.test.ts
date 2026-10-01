import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error browser module
import { createLearningSession } from '../../../web/demo/js/learning/session.js';
// @ts-expect-error browser module
import { DEFAULT_POLICY } from '../../../web/demo/js/engine/types.js';

for (const domain of ['ap', 'soc']) {
  test(`${domain}: manual KEEP, NEAR-MISS and DISCARD append immutable attempts`, () => {
    const masks = domain === 'ap' ? [0, 3, 63] : [0, 2, 3];
    for (const [index, mask] of masks.entries()) {
      const session = createLearningSession(domain, () => DEFAULT_POLICY, 7);
      session.load(); session.autoAnswer();
      session.state().examples.forEach((e: any, i: number) => {
        if (mask & (1 << i)) {
          const q = domain === 'ap' ? 'payee_mismatch' : 'goal_deviation';
          session.answer(e.id, q, !e.truth[q]); session.submit(e.id, 'Allow');
        }
      });
      const id = session.beginTrain(); session.finishTrain(id);
      const result = session.gate();
      assert.equal(result.verdict, ['KEEP', 'NEAR-MISS', 'DISCARD'][index]);
      const state = session.state();
      assert.equal(state.history.length, 1);
      assert.equal(state.champion.id, index === 0 ? 'v2' : 'v1');
      assert.equal(state.history[0].promotedTo, index === 0 ? 'v2' : null);
      assert.equal(session.gate(), null, 're-gating a frozen attempt cannot promote twice');
      const saved = JSON.stringify(state.history);
      state.history[0].snapshot.model.families = {};
      state.history[0].snapshot.labels[0].value = !state.history[0].snapshot.labels[0].value;
      assert.equal(JSON.stringify(session.state().history), saved, 'returned state cannot mutate records');
      session.select('v1'); assert.equal(session.state().selected, 'v1');
      session.select('attempt-1'); assert.equal(session.state().selected, 'attempt-1');
      session.select('missing'); assert.equal(session.state().selected, 'attempt-1');
    }
  });
  test(`${domain}: scripted context is deterministic and leaves the external policy untouched`, () => {
    const policy = structuredClone(DEFAULT_POLICY);
    policy.version = 'external-policy';
    Object.values(policy.tools).forEach((t: any) => { t.mode = 'monitor'; });
    const original = JSON.stringify(policy);
    let expected: string | null = null;
    for (const seed of [1, 7, 23, 50]) {
      const session = createLearningSession(domain, () => policy, seed);
      session.setFault('down'); session.startScript();
      assert.equal(session.scriptRound(2), null, 'rounds cannot be skipped');
      for (let round = 1; round <= 3; round++) session.scriptRound(round);
      const state = session.state();
      assert.deepEqual(state.history.map((r: any) => r.gate.verdict), ['NEAR-MISS', 'KEEP', 'DISCARD']);
      for (const r of state.history) {
        assert.equal(r.snapshot.seed, 7); assert.equal(r.snapshot.fault, null);
        assert.deepEqual(r.snapshot.policy, DEFAULT_POLICY);
      }
      const results = JSON.stringify(state.history.map((r: any) => r.gate));
      if (expected === null) expected = results; else assert.equal(results, expected);
      assert.equal(JSON.stringify(policy), original);
      session.reset(); assert.equal(session.scriptRound(1), null, 'stale scripted work cannot restart a reset session');
    }
  });
}
