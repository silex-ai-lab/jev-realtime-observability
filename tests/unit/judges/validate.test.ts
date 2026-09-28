// Validator tests start from the REAL recorded Kev responses and mutate them
// (missing required answer, NaN, sum ≠ 1, unknown option, legend mismatch, wrong type, out of range).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateResponse } from '../../../server/judges/index.ts';
import type { SystemOneRequest, SystemOneResponse } from '../../../contracts/judge.ts';

const fx = (p: string) => JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/${p}`, import.meta.url), 'utf8'));
const apReq = fx('kev/ap-request.json') as SystemOneRequest;
const apRes = fx('kev/ap-response.json') as SystemOneResponse;
const scoreReq = fx('kev/score-request.json') as SystemOneRequest;
const scoreRes = fx('kev/score-response.json') as SystemOneResponse;

test('ap response validates ok with all three signals', () => {
  const r = validateResponse(apReq, apRes, ['payee_relation', 'goal_deviation']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(Object.keys(r.signals).sort(), ['goal_deviation', 'instruction_override', 'payee_relation']);

  const payee = r.signals['payee_relation'];
  assert.equal(payee.type, 'choice');
  assert.equal(payee.choice, 'different_entity');            // argmax, not the vendor's label
  assert.ok(payee.probabilities && Math.abs(payee.probabilities['different_entity'] - 0.7113) < 1e-6);
  assert.ok(payee.margin_local != null && Math.abs(payee.margin_local - (0.7113 - 0.2499)) < 1e-6);
  assert.equal(payee.raw_probability, null);
  assert.equal(payee.p_calibrated, null);
  assert.equal(payee.calibration_id, null);

  const io = r.signals['instruction_override'];
  assert.equal(io.type, 'noul');
  assert.equal(io.raw_probability, 0.2959);
  assert.equal(io.vendor_confidence, null);
  assert.ok(Math.abs((io.margin_local ?? 0) - Math.abs(2 * 0.2959 - 1)) < 1e-6);
});

test('score response validates ok with legend and score in range', () => {
  const r = validateResponse(scoreReq, scoreRes, ['goal_deviation']);
  assert.equal(r.status, 'ok');
  const sem = r.signals['semantic_impact'];
  assert.equal(sem.type, 'score');
  assert.equal(sem.score, 1.5973);
  assert.deepEqual(sem.legend, { '0': 'none', '1': 'minor', '2': 'material', '3': 'severe' });
  assert.ok(Math.abs((sem.margin_local ?? 0) - (0.4102 - 0.259)) < 1e-6);
});

test('missing REQUIRED answer → invalid_response; missing optional → partial', () => {
  const missing = JSON.parse(JSON.stringify(apRes));
  delete missing.answers.payee_relation;                      // required
  assert.equal(validateResponse(apReq, missing, ['payee_relation', 'goal_deviation']).status, 'invalid_response');

  const missingOptional = JSON.parse(JSON.stringify(apRes));
  delete missingOptional.answers.instruction_override;        // optional
  const r = validateResponse(apReq, missingOptional, ['payee_relation', 'goal_deviation']);
  assert.equal(r.status, 'partial');
  assert.ok(r.errors.some(e => e.includes('instruction_override')));
  assert.equal(Object.keys(r.signals).length, 2);
});

test('NaN noul → invalid_response; out-of-range noul → invalid_response', () => {
  const nan = JSON.parse(JSON.stringify(apRes));
  nan.answers.goal_deviation.noul = Number.NaN;
  assert.equal(validateResponse(apReq, nan, ['goal_deviation']).status, 'invalid_response');

  const out = JSON.parse(JSON.stringify(apRes));
  out.answers.goal_deviation.noul = 1.5;
  assert.equal(validateResponse(apReq, out, ['goal_deviation']).status, 'invalid_response');
});

test('choice probabilities not summing to 1 → invalid_response', () => {
  const bad = JSON.parse(JSON.stringify(apRes));
  bad.answers.payee_relation.probabilities = { same_entity: 0.5, different_entity: 0.5, insufficient_evidence: 0.5 };
  const r = validateResponse(apReq, bad, ['payee_relation']);
  assert.equal(r.status, 'invalid_response');
  assert.ok(r.errors.some(e => e.includes('payee_relation') && e.includes('sum')));
});

test('unknown option in choice probabilities → invalid_response', () => {
  const bad = JSON.parse(JSON.stringify(apRes));
  bad.answers.payee_relation.probabilities = { same_entity: 0.3, different_entity: 0.7, other_option: 0.0 };
  const r = validateResponse(apReq, bad, ['payee_relation']);
  assert.equal(r.status, 'invalid_response');
  assert.ok(r.errors.some(e => e.includes('option set')));
});

test('legend mismatch in score → invalid_response', () => {
  const bad = JSON.parse(JSON.stringify(scoreRes));
  bad.answers.semantic_impact.legend = { '0': 'none', '1': 'minor', '2': 'huge', '3': 'severe' };
  assert.equal(validateResponse(scoreReq, bad, ['goal_deviation', 'semantic_impact']).status, 'invalid_response');
});

test('score out of range → invalid_response', () => {
  const bad = JSON.parse(JSON.stringify(scoreRes));
  bad.answers.semantic_impact.score = 3.5;
  assert.equal(validateResponse(scoreReq, bad, ['goal_deviation', 'semantic_impact']).status, 'invalid_response');
});

test('wrong answer type → invalid_response', () => {
  const bad = JSON.parse(JSON.stringify(apRes));
  bad.answers.payee_relation = { type: 'noul', noul: 0.4 };   // choice question given a noul answer
  const r = validateResponse(apReq, bad, ['payee_relation']);
  assert.equal(r.status, 'invalid_response');
  assert.ok(r.errors.some(e => e.includes('payee_relation') && e.includes('choice')));
});

test('raw that is not a response object → invalid_response (never 0 risk)', () => {
  assert.equal(validateResponse(apReq, null, ['payee_relation']).status, 'invalid_response');
  assert.equal(validateResponse(apReq, 'garbage', ['payee_relation']).status, 'invalid_response');
  assert.equal(validateResponse(apReq, { answers: 42 }, ['payee_relation']).status, 'invalid_response');
});
