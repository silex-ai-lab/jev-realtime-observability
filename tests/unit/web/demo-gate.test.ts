import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error browser module
import { decide, KEEP, NEAR_MISS, DISCARD } from '../../../web/demo/js/learning/gate.js';

const it = (positive: boolean, before: boolean, after: boolean) => ({ positive, correctBefore: before, correctAfter: after });
// errorsBefore - errorsAfter === fixed - broke, an identity the gate must preserve.
const totalErrors = (d: any) => ({ before: d.missed.before + d.falseHolds.before, after: d.missed.after + d.falseHolds.after });

test('KEEP: fixed > broke and the sign test clears α (5/0 gives p = 0.03125)', () => {
  const d = decide({ items: [it(true, true, true), ...Array.from({ length: 5 }, () => it(false, false, true))] });
  assert.equal(d.verdict, KEEP);
  assert.equal(d.reason, 'promoted');
  assert.equal(d.fixed, 5);
  assert.equal(d.broke, 0);
  assert.equal(d.p, 0.03125);
  assert.deepEqual(d.missed, { before: 0, after: 0 });
  assert.deepEqual(d.falseHolds, { before: 5, after: 0 });
  assert.equal(d.safetyOk, true);
  assert.equal(d.evidenceOk, true);
});

test('NEAR-MISS: fixed > broke but not enough evidence (4/0 gives p = 0.0625)', () => {
  const d = decide({ items: [it(true, true, true), ...Array.from({ length: 4 }, () => it(false, false, true))] });
  assert.equal(d.verdict, NEAR_MISS);
  assert.equal(d.reason, 'needs more evidence');
  assert.equal(d.fixed, 4);
  assert.equal(d.broke, 0);
  assert.equal(d.p, 0.0625);
  assert.equal(d.evidenceOk, false);
});

test('α boundary is inclusive at full precision: p === α still KEEPs', () => {
  const items = [it(true, true, true), ...Array.from({ length: 4 }, () => it(false, false, true))];
  const d = decide({ items, alpha: 0.0625 });
  assert.equal(d.p, 0.0625);
  assert.equal(d.verdict, KEEP);
  const justBelow = decide({ items, alpha: 0.0624 });
  assert.equal(justBelow.verdict, NEAR_MISS);
});

test('zero discordant pairs: DISCARD · not better, p = 1', () => {
  const d = decide({ items: [it(true, true, true), it(false, true, true)] });
  assert.equal(d.verdict, DISCARD);
  assert.equal(d.reason, 'not better');
  assert.equal(d.fixed, 0);
  assert.equal(d.broke, 0);
  assert.equal(d.p, 1);
  assert.equal(d.safetyOk, true);
  assert.equal(d.evidenceOk, false);
});

test('ties (fixed === broke): DISCARD · not better, no individual-regression claim', () => {
  const d = decide({ items: [it(true, false, true), it(false, false, true), it(true, true, false), it(false, true, false)] });
  assert.equal(d.verdict, DISCARD);
  assert.equal(d.reason, 'not better');
  assert.equal(d.fixed, 2);
  assert.equal(d.broke, 2);
  assert.deepEqual(d.missed, { before: 1, after: 1 });
  assert.deepEqual(d.falseHolds, { before: 1, after: 1 });
  assert.equal(d.safetyOk, true);
});

test('fixed < broke is a safety regression on false holds', () => {
  const d = decide({ items: [it(true, true, true), it(false, false, true), it(false, true, false), it(false, true, false)] });
  assert.equal(d.verdict, DISCARD);
  assert.equal(d.reason, 'made false holds worse');
  assert.equal(d.fixed, 1);
  assert.equal(d.broke, 2);
  assert.deepEqual(d.falseHolds, { before: 1, after: 2 });
  assert.equal(d.safetyOk, false);
});

test('safety veto on missed attacks', () => {
  const d = decide({ items: [it(false, true, true), it(true, false, true), it(true, true, false), it(true, true, false)] });
  assert.equal(d.verdict, DISCARD);
  assert.equal(d.reason, 'made missed attacks worse');
  assert.deepEqual(d.missed, { before: 1, after: 2 });
  assert.equal(d.safetyOk, false);
});

test('control veto: unchanged-and-correct controls are required, else DISCARD', () => {
  const items = [it(true, true, true), ...Array.from({ length: 5 }, () => it(false, false, true))];
  const d = decide({ items, controlsOk: false });
  assert.equal(d.verdict, DISCARD);
  assert.equal(d.reason, 'a control changed');
});

test('empty classes: no items, no positives, or no negatives fail closed as invalid', () => {
  assert.equal(decide({ items: [] }).verdict, DISCARD);
  assert.equal(decide({ items: [] }).reason, 'invalid evaluation');
  assert.equal(decide({ items: [] }).p, 1);
  assert.equal(decide({ items: [it(true, true, true)] }).reason, 'invalid evaluation');
  assert.equal(decide({ items: [it(false, true, true)] }).reason, 'invalid evaluation');
});

test('full precision at n = 19: fixed 17 / broke 2 gives p = 191 / 2^19', () => {
  const items = [
    ...Array.from({ length: 17 }, () => it(true, false, true)),   // 17 fixed (positive)
    ...Array.from({ length: 2 }, () => it(true, true, false)),    // 2 broke (positive)
    it(false, true, true),                                        // negative, both right (class presence)
  ];
  const d = decide({ items });
  assert.equal(d.fixed, 17);
  assert.equal(d.broke, 2);
  assert.ok(Math.abs(d.p - 191 / 524288) < 1e-12, `p = ${d.p}`);
  assert.equal(d.verdict, KEEP);
});

test('fixed − broke equals errorsBefore − errorsAfter across shapes', () => {
  const cases = [
    [it(true, true, true), it(false, false, true)],
    [it(true, false, true), it(false, false, true), it(true, true, false), it(false, true, false)],
    [it(true, true, true), it(false, false, true), it(false, true, false), it(false, true, false)],
    [it(false, true, true), it(true, false, true), it(true, true, false), it(true, true, false)],
    [...Array.from({ length: 17 }, () => it(true, false, true)), ...Array.from({ length: 2 }, () => it(true, true, false)), it(false, true, true)],
  ];
  for (const items of cases) {
    const d = decide({ items });
    const e = totalErrors(d);
    assert.equal(d.fixed - d.broke, e.before - e.after, `fixed−broke vs errors for ${JSON.stringify(d)}`);
  }
});
