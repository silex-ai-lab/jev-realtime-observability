import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error browser module
import { curriculumFor, requiredLabels } from '../../../web/demo/js/learning/curriculum.js';
// @ts-expect-error browser module
import { createLearningSession, compareCases, gatePairs } from '../../../web/demo/js/learning/session.js';
// @ts-expect-error browser module
import { scorerFor, trainCorrection } from '../../../web/demo/js/learning/model.js';
// @ts-expect-error browser module
import { DEFAULT_POLICY, BATTERY } from '../../../web/demo/js/engine/types.js';
// @ts-expect-error browser module
import { TENANT, buildStream, scenariosFor } from '../../../web/demo/js/engine/scenarios.js';
// @ts-expect-error browser module
import { buildState } from '../../../web/demo/js/engine/state.js';
// @ts-expect-error browser module
import { runStream } from '../../../web/demo/js/engine/router.js';
// @ts-expect-error browser module
import { judgeBattery } from '../../../web/demo/js/engine/jev-sim.js';
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function states(spans: any[]): string[] {
  const history: any[] = [], out: string[] = [];
  for (const span of spans) {
    if (!span.boundary) continue;
    out.push(JSON.stringify(buildState(span, history, TENANT, span.t_ms ?? 0).safeView));
    history.push(...runStream([span], { tenant: TENANT, policy: DEFAULT_POLICY, seed: 7, history }));
  }
  return out;
}
function trained(domain: string, failed = false, seed = 7): any {
  const s = createLearningSession(domain, () => DEFAULT_POLICY, seed);
  s.load(); s.autoAnswer(); s.failed(failed); assert.equal(s.finishTrain(s.beginTrain()), true); return s;
}
for (const domain of ['ap', 'soc']) {
  test(`${domain}: actual model-facing holdout states are disjoint from teaching and Live states`, () => {
    const c = curriculumFor(domain);
    const review = new Set(c.review.flatMap((e: any) => states(e.spans)));
    const live = new Set([...states(buildStream(7, { domain })), ...scenariosFor(domain).flatMap((t: any) => states(t.spans))]);
    const held = c.test.flatMap((e: any) => states(e.spans));
    assert.equal(new Set(held).size, held.length);
    for (const s of held) { assert.equal(review.has(s), false); assert.equal(live.has(s), false); }
    assert.equal(requiredLabels(domain), c.review.reduce((n: number, e: any) => n + Object.keys(e.truth).length, 0));
  });
  test(`${domain}: default-seed pass/rejection and deterministic actions/controls across seeds 1–50`, () => {
    for (let seed = 1; seed <= 50; seed++) for (const failed of [false, true]) {
      const s = trained(domain, failed, seed), g = s.gate(); assert.equal(g.valid, true); if (seed === 7) assert.equal(g.pass, !failed, `seed ${seed}, failed ${failed}`);
      const again = trained(domain, failed, seed).gate(); assert.deepEqual(g, again);
      assert.equal(g.before.total, 4, 'ALLOW by policy is included');
      for (const p of g.pairs) {
        if (p.control) { assert.equal(p.eligible, false); assert.equal(p.correctControl, true); assert.equal(p.before.action, p.after.action); }
        assert.deepEqual(p.before.answers.attack, p.after.answers.attack); assert.deepEqual(p.before.answers.impact, p.after.answers.impact);
      }
      assert.equal(s.promote(), g.pass);
    }
  });
  test(`${domain}: frozen candidate, no heldout-truth oracle, and label edits invalidate approval`, () => {
    const s = trained(domain), snapshot = s.state().candidate.snapshot;
    const c = curriculumFor(domain), original = compareCases(c.test, snapshot, snapshot.model);
    c.test.forEach((e: any) => { e.truth = Object.fromEntries(Object.entries(e.truth).map(([k, v]) => [k, !v])); e.kind = e.kind === 'attack' ? 'benign' : 'attack'; });
    assert.deepEqual(compareCases(c.test, snapshot, snapshot.model).map((p: any) => p.after), original.map((p: any) => p.after));
    assert.equal(s.gate().pass, true); const e = s.state().examples[0], q = Object.keys(e.truth)[0];
    s.answer(e.id, q, !e.truth[q]); assert.equal(s.state().candidate, null); assert.equal(s.promote(), false);
    assert.equal(s.state().count, s.state().N - 1); s.submit(e.id, 'Deny'); assert.equal(s.state().count, s.state().N);
    s.load(); s.submit(e.id, 'Deny'); assert.equal(s.state().count, s.state().N);
  });
  test(`${domain}: stale animation completion, policy/fault edits, reset and empty metrics fail closed`, () => {
    const s = trained(domain); s.gate(); s.failed(true); assert.equal(s.promote(), false);
    const id = s.beginTrain(); s.reset(); assert.equal(s.finishTrain(id), false); assert.equal(s.state().count, 0);
    const p = trained(domain); p.gate(); p.policyChanged(); assert.equal(p.promote(), false);
    const f = trained(domain); f.gate(); f.setFault('down'); assert.equal(f.promote(), false);
    assert.equal(gatePairs([]).valid, false); assert.equal(gatePairs([]).pass, false);
    const snapshot = trained(domain).state().candidate.snapshot;
    const monitor = copy(snapshot.policy); Object.values(monitor.tools).forEach((t: any) => { t.mode = 'monitor'; });
    assert.equal(gatePairs(compareCases(curriculumFor(domain).test, { ...snapshot, policy: monitor }, snapshot.model)).valid, false);
  });
}
test('default router scorer is byte-identical; unlabelled answers, faults and reduced battery fields pass through', () => {
  const spans = buildStream(7), ctx = { tenant: TENANT, policy: DEFAULT_POLICY, seed: 7 };
  assert.deepEqual(runStream(spans, ctx), runStream(spans, { ...ctx, scorer: judgeBattery }));
  const q = BATTERY.find((q: any) => q.id === 'grounded');
  const safe = { features: { unsupported_claims: 2 } }, opts = { seed: 7, spanId: 'test-grounded', deadline_ms: 400 };
  const original = judgeBattery(safe, [q], opts);
  const model = trainCorrection([{ key: 'g', qid: q.id, value: true, answer: original.answers[q.id] }]);
  const changed = scorerFor(model)(safe, [q], opts);
  assert.equal(changed.answers.grounded.risk, Math.round((1 - changed.answers.grounded.p) * 1000) / 1000);
  for (const fault of ['timeout', 'down', 'rtt_spike']) {
    const before = judgeBattery(safe, [q], { ...opts, fault }), after = scorerFor(model)(safe, [q], { ...opts, fault });
    for (const key of ['status', 'latency_ms', 'serialize_ms', 'reduced', 'tokens_in', 'cost_usd']) assert.deepEqual(after[key], before[key]);
    if (before.status !== 'ok') assert.deepEqual(after, before);
  }
  assert.deepEqual(scorerFor(trainCorrection([]))(safe, [q], opts).answers, original.answers);
});
