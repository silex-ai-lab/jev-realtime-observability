// F0 of logs/2026-09-30_CONSOLE_UX_PLAN.md: every row of the two wording tables, the fallbacks, the step kinds,
// contradictions, the Why-line precedence, claim-time lines, and the negative property (a receipt decides "ran").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callKind, claimTimeLines, decisionPart, executionPart, isContradiction, lineVerdict, signalsLine, summarize, whyLine } from '../../../web/js/verdict.js';

const RECS = ['NO_CONFIGURED_RISK', 'ALERT', 'HOLD', 'REVIEW', 'UNKNOWN', 'BLOCK', 'STOP', 'REJECT', 'SOMETHING_NEW', null];

test('part 1, gated calls: enforcement words only here', () => {
  const g = (recommended: string | null, decidedBy?: string) => decisionPart({ mode: 'gate', kind: 'gated', recommended, decidedBy }).text;
  assert.equal(g('NO_CONFIGURED_RISK'), 'No objection');
  assert.equal(g('ALERT'), 'Flagged');
  assert.equal(g('HOLD', 'rule'), 'Held for approval');
  assert.equal(g('HOLD', 'judge_unavailable'), 'Held for review');
  assert.equal(g('REVIEW'), 'Held for review');
  assert.equal(g('UNKNOWN'), 'Held for review');
  for (const r of ['BLOCK', 'STOP', 'REJECT']) assert.equal(g(r), 'Blocked');
  assert.equal(g(null), 'Deciding…');
  assert.equal(g('SOMETHING_NEW'), 'Decision: SOMETHING_NEW');
});

test('part 1, ungated calls and shadow mode: recommendations, never enforcement words', () => {
  const u = (mode: string, recommended: string, decidedBy?: string) => decisionPart({ mode, kind: 'ungated', recommended, decidedBy }).text;
  assert.equal(u('gate', 'HOLD', 'rule'), 'Recommended: hold for approval (not enforced)');
  assert.equal(u('gate', 'UNKNOWN'), 'Recommended: hold for review (not enforced)');
  assert.equal(u('gate', 'STOP'), 'Recommended: block (not enforced)');
  assert.equal(u('shadow', 'HOLD', 'rule'), 'Would hold for approval');
  assert.equal(u('shadow', 'REVIEW'), 'Would hold for review');
  assert.equal(u('shadow', 'BLOCK'), 'Would block');
  assert.equal(u('shadow', 'ALERT'), 'Flagged');
  for (const mode of ['gate', 'shadow']) for (const r of RECS) {
    const t = decisionPart({ mode, kind: 'ungated', recommended: r }).text;
    assert.ok(!/Held|Blocked/.test(t), `${mode} ${r}: ${t}`);
    assert.ok(!t.includes('⛔'), 'plan r5 L12: the UI draws the icon; the text carries none');
  }
});

test('part 1, statements (after the fact): investigation wording, never enforcement', () => {
  const s = (recommended: string | null) => decisionPart({ mode: 'gate', kind: 'statement', recommended }).text;
  assert.equal(s('NO_CONFIGURED_RISK'), 'No objection');
  assert.equal(s('ALERT'), 'Flagged');
  for (const r of ['HOLD', 'REVIEW', 'UNKNOWN', 'BLOCK', 'STOP', 'REJECT']) assert.equal(s(r), 'Recommended: open an investigation');
});

test('part 2 from the receipt only, with a fallback', () => {
  assert.equal(executionPart('executed').text, 'ran');
  assert.equal(executionPart('not_executed').text, 'did not run');
  assert.equal(executionPart('failed').text, 'attempt failed (refused by the tool)');
  assert.equal(executionPart(undefined).text, 'result pending');
  assert.equal(executionPart('weird').text, 'result: weird');
});

test('call kind: a control means gated; before the receipt, gate mode + non-read impact means gated', () => {
  assert.equal(callKind({ mode: 'gate', controlAction: 'allow', impact: 'read' }), 'gated');
  assert.equal(callKind({ mode: 'gate', impact: 'write' }), 'gated');
  assert.equal(callKind({ mode: 'gate', impact: 'payment' }), 'gated');
  assert.equal(callKind({ mode: 'gate', impact: 'read' }), 'ungated');
  assert.equal(callKind({ mode: 'shadow', impact: 'write' }), 'ungated');
});

test('composition, the SOC and AP lines, and contradictions (shown, never resolved)', () => {
  assert.deepEqual(lineVerdict({ mode: 'gate', kind: 'gated', recommended: 'HOLD', decidedBy: 'rule', receiptStatus: 'not_executed', controlAction: 'hold_for_approval', impact: 'write' }),
    { text: 'Held for approval · did not run', tone: 'stop', contradiction: false });
  assert.deepEqual(lineVerdict({ mode: 'gate', kind: 'gated', recommended: 'BLOCK', receiptStatus: 'not_executed', controlAction: 'deny', impact: 'write' }),
    { text: 'Blocked · did not run', tone: 'stop', contradiction: false });
  assert.equal(lineVerdict({ mode: 'gate', kind: 'gated', recommended: 'NO_CONFIGURED_RISK', receiptStatus: 'executed', controlAction: 'allow', impact: 'write' }).text, 'No objection · ran');
  assert.equal(lineVerdict({ mode: 'gate', kind: 'ungated', recommended: 'ALERT', receiptStatus: 'executed', impact: 'read' }).text, 'read-only · Flagged · ran');
  assert.equal(lineVerdict({ mode: 'shadow', kind: 'ungated', recommended: 'HOLD', decidedBy: 'rule', receiptStatus: 'executed', impact: 'write' }).text, 'Would hold for approval · ran');
  // contradictions only on gated calls
  const heldRan = lineVerdict({ mode: 'gate', kind: 'gated', recommended: 'HOLD', decidedBy: 'rule', receiptStatus: 'executed', controlAction: 'hold_for_approval', impact: 'write' });
  assert.deepEqual([heldRan.text, heldRan.contradiction, heldRan.tone], ['Held for approval · ran', true, 'warn']);
  const allowNot = lineVerdict({ mode: 'gate', kind: 'gated', recommended: 'NO_CONFIGURED_RISK', receiptStatus: 'not_executed', controlAction: 'allow', impact: 'write' });
  assert.deepEqual([allowNot.text, allowNot.contradiction], ['No objection · did not run', true]);
  // an ungated read with an intervention recommendation that ran is not a contradiction
  for (const r of ['STOP', 'UNKNOWN']) {
    const v = lineVerdict({ mode: 'gate', kind: 'ungated', recommended: r, receiptStatus: 'executed', impact: 'read' });
    assert.equal(v.contradiction, false);
    assert.match(v.text, /^read-only · Recommended: .* \(not enforced\) · ran$/);
  }
  assert.equal(isContradiction({ kind: 'ungated', controlAction: undefined, receiptStatus: 'executed' }), false);
});

test('statements have no receipt part; a statement with a HOLD (defensive: not reachable today) gets investigation wording', () => {
  const v = lineVerdict({ mode: 'gate', kind: 'statement', recommended: 'HOLD', decidedBy: 'rule' });
  assert.equal(v.text, 'Recommended: open an investigation');
  assert.ok(!/ran|did not run|pending/.test(v.text));
});

test('negative property: the receipt alone decides ran / did not run, for every decision, kind and mode', () => {
  for (const mode of ['gate', 'shadow']) for (const kind of ['gated', 'ungated']) for (const r of RECS) {
    const ran = lineVerdict({ mode, kind, recommended: r, receiptStatus: 'executed', controlAction: kind === 'gated' ? 'hold_for_approval' : undefined, impact: 'write' }).text;
    const not = lineVerdict({ mode, kind, recommended: r, receiptStatus: 'not_executed', controlAction: kind === 'gated' ? 'deny' : undefined, impact: 'write' }).text;
    assert.ok(ran.endsWith(' · ran') && !ran.includes('did not run'), `${mode}/${kind}/${r}: ${ran}`);
    assert.ok(not.endsWith(' · did not run') && !/ · ran$/.test(not), `${mode}/${kind}/${r}: ${not}`);
  }
});

test('Why line: failing rule reasons first; else decision reasons (judge unavailable, evidence gate); N only when rules exist', () => {
  const rule = whyLine({ recommended: 'HOLD', decided_by: 'rule', rule_results: [{ verdict: 'HOLD', reason: 'allowlisting an IP without an approved change for it' }, { verdict: 'PASS', reason: 'x' }, { verdict: 'PASS', reason: 'y' }], reasons: ['ignored'] })!;
  assert.deepEqual(rule, { reasons: ['allowlisting an IP without an approved change for it'], source: 'rules', passedNote: '(2 rule checks passed)' });
  const judge = whyLine({ recommended: 'HOLD', decided_by: 'judge_unavailable', rule_results: [{ verdict: 'PASS', reason: 'a' }], reasons: ['required judge answer unavailable'] })!;
  assert.deepEqual(judge, { reasons: ['required judge answer unavailable'], source: 'judge_unavailable', passedNote: '(1 rule checks passed)' });
  const gate = whyLine({ recommended: 'UNKNOWN', decided_by: 'evidence_gate', rule_results: [], reasons: ['missing evidence: authority:soc_user'] })!;
  assert.deepEqual(gate, { reasons: ['missing evidence: authority:soc_user'], source: 'evidence_gate', passedNote: null });
  const two = whyLine({ recommended: 'BLOCK', rule_results: [{ verdict: 'BLOCK', reason: 'a' }, { verdict: 'HOLD', reason: 'b' }] })!;
  assert.deepEqual(two.reasons, ['a', 'b']);
  assert.equal(whyLine({ recommended: 'NO_CONFIGURED_RISK', rule_results: [] }), null);
});

test('claim-time lines are the decision reasons verbatim, whatever the recommendation', () => {
  const reasons = ['authoritative outcomes at claim time: payments.execute pending', 'completion claimed (uncalibrated signal 0.612) without a verified success record at claim time'];
  assert.deepEqual(claimTimeLines({ recommended: 'NO_CONFIGURED_RISK', reasons }), reasons);
  assert.deepEqual(claimTimeLines(null), []);
});

test('summary buckets by receipt: did-not-run splits into stopped by Silex vs other', () => {
  const s = summarize([{ receiptStatus: 'executed' }, { receiptStatus: 'not_executed', controlAction: 'hold_for_approval' }, { receiptStatus: 'not_executed', controlAction: 'allow' },
    { receiptStatus: 'failed' }, {}]);
  assert.deepEqual(s, { calls: 5, ran: 1, didNotRun: 2, stoppedBySilex: 1, didNotRunOther: 1, failed: 1, pending: 1 });
});

test('judge-signal line (U6): realtime first, else diagnostic; always labelled uncalibrated and non-blocking', () => {
  const rt = { kind: 'realtime', signals: { goal_deviation: { raw_probability: 0.4591 }, semantic_impact: { score: 1.198 }, payee_relation: { choice: 'same_entity' } } };
  assert.deepEqual(signalsLine([rt]), { label: 'judge signals (uncalibrated, never block)', text: 'goal_deviation 0.46 · semantic_impact score 1.20 · payee_relation same_entity' });
  const diag = { kind: 'diagnostic', signals: { sensitive_data_transfer: { raw_probability: 0.3 } } };
  assert.deepEqual(signalsLine([diag]), { label: 'judge signals (uncalibrated, never block; diagnostic, after the decision)', text: 'sensitive_data_transfer 0.30' });
  assert.equal(signalsLine([{ kind: 'realtime', signals: {} }]), null);
  assert.equal(signalsLine(undefined), null);
});
