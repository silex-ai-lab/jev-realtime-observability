import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error browser module
import { curriculumFor, requiredLabels, carelessBatchFor } from '../../../web/demo/js/learning/curriculum.js';
// @ts-expect-error browser module
import { createLearningSession, compareCases, gatePairs } from '../../../web/demo/js/learning/session.js';
// @ts-expect-error browser module
import { scorerFor, trainCorrection, encode } from '../../../web/demo/js/learning/model.js';
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
  s.load(); s.autoAnswer(); if (failed) s.addCareless(); assert.equal(s.finishTrain(s.beginTrain()), true); return s;
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
  test(`${domain}: primary semantic truths admit a linear separator in the existing encoded features`, () => {
    // A test-only separability witness, never a training parameter or a deployed scorer.
    // Controls are outside learning metrics. This includes the residual false-hold cases:
    // finite training can underfit a separable set or miss an unseen missing-feature flag.
    const c = curriculumFor(domain), qid = domain === 'ap' ? 'payee_mismatch' : 'goal_deviation';
    const question = BATTERY.find((q: any) => q.id === qid);
    for (const e of [...c.review, ...c.test]) {
      const env = runStream(e.spans, { tenant: TENANT, policy: DEFAULT_POLICY, seed: 7 }).find((v: any) => v.span_id === e.target);
      if (env.decided_by === 'rule') continue;
      const x = encode(env.answers[qid].features_used, question.features);
      const truth = domain === 'ap' ? x[0] > 0.58 : 1 - x[0] - x[1] > 0.5;
      assert.equal(truth, e.truth[qid], e.id);
    }
  });

  test(`${domain}: computed rounds, champion-relative regression, frozen history and quarantine`, () => {
    const s = createLearningSession(domain, () => DEFAULT_POLICY, 23); s.startScript();
    const expected = domain === 'ap' ? [[4,0,.0625],[9,0,.001953125],[0,4,1]] : [[3,0,.125],[7,1,.03515625],[0,2,1]];
    for (let round=1; round<=3; round++) {
      const g=s.scriptRound(round); const [f,b,p]=expected[round-1];
      assert.equal(g.verdict,['NEAR-MISS','KEEP','DISCARD'][round-1]);
      assert.deepEqual([g.fixed,g.broke,g.p],[f,b,p]);
      assert.equal(g.fixed-g.broke,g.before.missed+g.before.falseHolds-g.after.missed-g.after.falseHolds);
      assert.equal(s.state().champion.id,round===1?'v1':'v2');
      for(const pair of g.pairs) {
        if(pair.control) {assert.equal(pair.eligible,false);assert.equal(pair.correctControl,true);}
        assert.deepEqual(pair.before.answers.attack,pair.after.answers.attack);
        assert.deepEqual(pair.before.answers.impact,pair.after.answers.impact);
      }
    }
    const state=s.state(); assert.equal(state.history[2].championBefore,'v2');
    assert.deepEqual(state.history.map((r:any)=>r.snapshot.labels.length),[3,18,24]);
    assert.equal(state.history[2].gate.before.missed,0); assert.equal(state.history[2].gate.before.falseHolds,1);
    assert.equal(state.history[2].gate.after.falseHolds,domain==='ap'?5:3);
    assert.equal(state.quarantine.length,2); assert.equal(state.labelCount,18);
    const frozen=copy(state.history); s.autoAnswer(); assert.equal(s.state().labelCount,18,'auto filling cannot revive quarantined labels');
    s.beginTrain(); s.finishTrain(s.state().candidate.id); const next=s.gate();
    assert.equal(next.verdict,'DISCARD'); assert.equal(next.fixed,0); assert.equal(next.broke,0);
    assert.equal(s.state().history[3].snapshot.labels.length,18);
    s.policyChanged();s.setFault('down');
    assert.deepEqual(s.state().history.slice(0,3),frozen);
    const e=s.state().examples[0];s.answer(e.id,Object.keys(e.truth)[0],true);assert.deepEqual(s.state().history.slice(0,3),frozen);
    s.reset();assert.equal(s.state().history.length,0);assert.equal(s.state().champion.id,'v1');assert.deepEqual(s.state().quarantine,[]);
  });
  test(`${domain}: manual readiness, truth isolation, edit invalidation and invalid evaluations`, () => {
    const s=createLearningSession(domain,()=>DEFAULT_POLICY,7);s.load();assert.equal(s.beginTrain(),null);s.autoAnswer();
    const id=s.beginTrain();assert.ok(id);assert.equal(s.finishTrain(id),true);
    const snapshot=s.state().candidate.snapshot,c=curriculumFor(domain),original=compareCases(c.test,snapshot,snapshot.model);
    for(const e of c.test) {e.truth=Object.fromEntries(Object.entries(e.truth).map(([k,v])=>[k,!v]));e.kind=e.kind==='attack'?'benign':'attack';}
    assert.deepEqual(compareCases(c.test,snapshot,snapshot.model).map((p:any)=>p.after),original.map((p:any)=>p.after));
    const g=s.gate();assert.equal(g.verdict,'KEEP');assert.equal(s.gate(),null,'cannot promote the same attempt twice');
    const frozen=copy(s.state().history),e=s.state().examples[0],q=Object.keys(e.truth)[0];
    s.answer(e.id,q,!e.truth[q]);assert.equal(s.state().candidate,null);assert.equal(s.state().count,s.state().N-1);
    s.submit(e.id,'Deny');assert.equal(s.state().count,s.state().N);assert.deepEqual(s.state().history,frozen);
    s.load();s.submit(e.id,'Deny');assert.equal(s.state().count,s.state().N);
    const pending=s.beginTrain();s.reset();assert.equal(s.finishTrain(pending),false);assert.equal(s.gate(),null);
    for(const fault of ['down','timeout','rtt_spike']) {const pairs=compareCases(curriculumFor(domain).test,{...snapshot,fault},snapshot.model);const g=gatePairs(pairs);assert.equal(g.verdict,'DISCARD');assert.equal(g.valid,false);}
    assert.equal(gatePairs([]).pass,false);assert.equal(gatePairs(original.filter((p:any)=>p.kind==='benign')).valid,false);
    const monitor=copy(snapshot.policy);Object.values(monitor.tools).forEach((t:any)=>{t.mode='monitor';});
    assert.equal(gatePairs(compareCases(curriculumFor(domain).test,{...snapshot,policy:monitor},snapshot.model)).valid,false);
    const bad=copy(original);bad.find((p:any)=>p.control).correctControl=false;assert.equal(gatePairs(bad).verdict,'DISCARD');assert.equal(gatePairs(bad).reason,'a control changed','a changed control gets its own reason');assert.equal(gatePairs(bad).pass,false);
    const invalid=copy(original);invalid.find((p:any)=>p.eligible).eligible=false;assert.equal(gatePairs(invalid).valid,false,'invalid pair cannot silently disappear');
  });
  test(`${domain}: careless model-facing states are disjoint from review, test and Live`, () => {
    const c=curriculumFor(domain),bad=carelessBatchFor(domain);
    const other=new Set([...c.review,...c.test].flatMap((e:any)=>states(e.spans)).concat(states(buildStream(7,{domain}))));
    const newStates=bad.flatMap((e:any)=>states(e.spans));assert.equal(new Set(newStates).size,newStates.length);
    for(const value of newStates)assert.equal(other.has(value),false);
    for(const e of bad)assert.equal(Object.keys(e.truth).filter(q=>e.truth[q]!==e.reviewerLabels[q]).length,1);
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
