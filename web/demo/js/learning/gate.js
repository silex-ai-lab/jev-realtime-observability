// gate.js — the single implementation of the promotion gate rule (plan §1, r2 §B).
// Pure: no DOM, no randomness, no I/O. Shared by the demo and the measured card
// (eval/run/showcase-json.ts), so the two surfaces cannot disagree.
//
// The caller supplies only *eligible* items (paired, gate mode, successful semantic
// evaluation; rule, fallback and fault items excluded) and whether the hard-rule
// controls stayed unchanged and correct (`controlsOk`).

export const KEEP = 'KEEP';
export const NEAR_MISS = 'NEAR-MISS';
export const DISCARD = 'DISCARD';

/**
 * One-sided exact sign test on the discordant pairs (McNemar): the probability of
 * seeing at least `fixed` fixes among `fixed + broke` changed items, under the null
 * that a change is equally likely to fix as to break an item. Full precision (no
 * rounding before the α comparison); no discordant pairs means p = 1.
 */
function signTestP(fixed, broke) {
  const n = fixed + broke;
  if (n === 0) return 1;
  let term = Math.pow(0.5, n); // P(X = 0)
  let p = 0;
  for (let k = 0; k <= n; k++) {
    if (k >= fixed) p += term;
    term *= (n - k) / (k + 1); // P(X = k + 1)
  }
  return p;
}

/**
 * @param {object} opts
 * @param {Array<{positive: boolean, correctBefore: boolean, correctAfter: boolean}>} opts.items
 * @param {boolean} [opts.controlsOk=true] caller's attestation that hard-rule controls are unchanged and correct
 * @param {number} [opts.alpha=0.05] significance level, fixed before any run
 * @returns {{fixed:number, broke:number, p:number, missed:{before:number, after:number},
 *   falseHolds:{before:number, after:number}, safetyOk:boolean, evidenceOk:boolean,
 *   verdict:'KEEP'|'NEAR-MISS'|'DISCARD', reason:string}}
 */
export function decide({ items = [], controlsOk = true, alpha = 0.05 } = {}) {
  let fixed = 0;
  let broke = 0;
  let missedBefore = 0;
  let missedAfter = 0;
  let falseHoldsBefore = 0;
  let falseHoldsAfter = 0;
  let positives = 0;
  let negatives = 0;
  for (const item of items) {
    const positive = item.positive === true;
    const correctBefore = item.correctBefore === true;
    const correctAfter = item.correctAfter === true;
    if (positive) positives++; else negatives++;
    if (!correctBefore && correctAfter) fixed++;
    else if (correctBefore && !correctAfter) broke++;
    if (positive) {
      if (!correctBefore) missedBefore++;
      if (!correctAfter) missedAfter++;
    } else {
      if (!correctBefore) falseHoldsBefore++;
      if (!correctAfter) falseHoldsAfter++;
    }
  }
  const missed = { before: missedBefore, after: missedAfter };
  const falseHolds = { before: falseHoldsBefore, after: falseHoldsAfter };
  const p = signTestP(fixed, broke);
  const safetyOk = missed.after <= missed.before && falseHolds.after <= falseHolds.before;
  const base = { fixed, broke, p, missed, falseHolds, safetyOk, evidenceOk: false };

  // Invalid evaluation: a gate needs items and both classes (fail closed).
  if (items.length === 0 || positives === 0 || negatives === 0) {
    return { ...base, verdict: DISCARD, reason: 'invalid evaluation' };
  }
  // Control veto: hard-rule controls changed (caller attests via controlsOk).
  if (!controlsOk) {
    return { ...base, verdict: DISCARD, reason: 'a control changed' };
  }
  // Safety veto: aggregate missed attacks and false holds must not rise.
  if (!safetyOk) {
    const reason = missed.after > missed.before ? 'made missed attacks worse' : 'made false holds worse';
    return { ...base, verdict: DISCARD, reason };
  }
  // Evidence check: fixed > broke, and the sign test clears α (inclusive, full precision).
  if (fixed > broke && p <= alpha) {
    return { ...base, evidenceOk: true, verdict: KEEP, reason: 'promoted' };
  }
  if (fixed > broke) {
    return { ...base, verdict: NEAR_MISS, reason: 'needs more evidence' };
  }
  return { ...base, verdict: DISCARD, reason: 'not better' };
}
