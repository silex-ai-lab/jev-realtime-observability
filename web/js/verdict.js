// Plain-language wording for the Runs view (logs/2026-09-30_CONSOLE_UX_PLAN.md §2). Pure: no DOM, no fetch.
// A line has two independent parts: what Silex decided (from the decision) and what happened to the call
// (from the gateway receipt). Neither part is ever derived from the other. Enforcement words ("Held",
// "Blocked") are used only for gated calls, where a gate control exists.

/** Step kinds: 'gated' (a gate control exists), 'ungated' (read tools; every call in shadow mode), 'statement' (post_generation). */
export const STEP_KINDS = ['gated', 'ungated', 'statement'];

const BLOCKING = new Set(['BLOCK', 'STOP', 'REJECT']);
const REVIEWING = new Set(['REVIEW', 'UNKNOWN']);

/** Classifies a tool call. `controlAction` wins; before the post_tool arrives, gate mode + non-read impact means gated. */
export function callKind({ mode, controlAction, impact }) {
  if (controlAction) return 'gated';
  if (mode === 'gate' && impact && impact !== 'read') return 'gated';
  return 'ungated';
}

/** Part 1: what Silex decided, worded for the step kind and mode. */
export function decisionPart({ mode, kind, recommended, decidedBy }) {
  if (!recommended) return { text: 'Deciding…', level: 'pending' };
  if (recommended === 'NO_CONFIGURED_RISK') return { text: 'No objection', level: 'none' };
  if (recommended === 'ALERT') return { text: 'Flagged', level: 'flag' };
  const hold = recommended === 'HOLD', review = REVIEWING.has(recommended), block = BLOCKING.has(recommended);
  if (!hold && !review && !block) return { text: `Decision: ${recommended}`, level: 'flag' };
  const what = block ? 'block' : hold && decidedBy === 'rule' ? 'hold for approval' : 'hold for review';
  if (kind === 'statement') return { text: 'Recommended: open an investigation', level: 'flag' };
  if (kind === 'gated') {
    const txt = block ? 'Blocked' : what === 'hold for approval' ? 'Held for approval' : 'Held for review';
    return { text: txt, level: 'stop' };
  }
  // Ungated: nothing enforces the recommendation. Shadow mode says so in the header, so "Would …" is enough there.
  return mode === 'shadow' ? { text: `Would ${what}`, level: 'flag' } : { text: `Recommended: ${what} (not enforced)`, level: 'flag' };
}

/** Part 2: what happened to the call, from the receipt only. */
export function executionPart(receiptStatus) {
  if (receiptStatus == null) return { text: 'result pending', level: 'pending' };
  if (receiptStatus === 'executed') return { text: 'ran', level: 'ran' };
  if (receiptStatus === 'not_executed') return { text: 'did not run', level: 'notrun' };
  if (receiptStatus === 'failed') return { text: 'attempt failed (refused by the tool)', level: 'failed' };
  return { text: `result: ${receiptStatus}`, level: 'pending' };
}

/** True when a gated call's control and receipt disagree (shown, never resolved). */
export function isContradiction({ kind, controlAction, receiptStatus }) {
  if (kind !== 'gated' || !controlAction || !receiptStatus) return false;
  if (controlAction === 'allow') return receiptStatus === 'not_executed';
  return receiptStatus === 'executed';
}

/**
 * One line's verdict. For a call: `[read-only · ] <part 1> · <part 2>`. For a statement: part 1 only.
 * tone: 'stop' (did not run / blocked), 'warn' (ran despite a flag or recommendation, or a contradiction),
 * 'fail' (attempt failed), 'pending', 'ok'.
 */
export function lineVerdict({ mode, kind, recommended, decidedBy, receiptStatus, controlAction, impact }) {
  const p1 = decisionPart({ mode, kind, recommended, decidedBy });
  if (kind === 'statement') {
    return { text: p1.text, tone: p1.level === 'none' ? 'ok' : p1.level === 'pending' ? 'pending' : 'warn', contradiction: false };
  }
  const p2 = executionPart(receiptStatus);
  const contradiction = isContradiction({ kind, controlAction, receiptStatus });
  const prefix = impact === 'read' ? 'read-only · ' : '';
  let tone;
  if (contradiction) tone = 'warn';
  else if (p2.level === 'notrun') tone = 'stop';
  else if (p2.level === 'failed') tone = 'fail';
  else if (p2.level === 'pending') tone = p1.level === 'stop' ? 'stop' : 'pending';
  else tone = p1.level === 'none' ? 'ok' : 'warn';
  return { text: `${prefix}${p1.text} · ${p2.text}`, tone, contradiction };
}

/**
 * Why line: reasons of the rules that did not PASS (verbatim); else the decision's own reasons with decided_by.
 * "(N rule checks passed)" only when at least one rule result passed; N counts PASS results.
 */
export function whyLine(decision) {
  if (!decision || decision.recommended === 'NO_CONFIGURED_RISK') return null;
  const rules = Array.isArray(decision.rule_results) ? decision.rule_results : [];
  const failing = rules.filter(r => r.verdict !== 'PASS');
  const passed = rules.filter(r => r.verdict === 'PASS').length;
  const reasons = failing.length ? failing.map(r => r.reason)
    : (Array.isArray(decision.reasons) && decision.reasons.length ? decision.reasons : [`decided by ${decision.decided_by ?? 'unknown'}`]);
  return { reasons, source: failing.length ? 'rules' : (decision.decided_by ?? 'decision'), passedNote: passed ? `(${passed} rule check${passed === 1 ? '' : 's'} passed)` : null };
}

/** Claim-time lines for a statement: the decision's own reasons, verbatim, whatever the recommendation. */
export function claimTimeLines(decision) {
  return decision && Array.isArray(decision.reasons) ? decision.reasons.filter(r => typeof r === 'string' && r.length) : [];
}

/** Session/run summary over tool calls: counts by receipt (plan §2 "Summary strip buckets"). */
export function summarize(calls) {
  const s = { calls: 0, ran: 0, didNotRun: 0, stoppedBySilex: 0, didNotRunOther: 0, failed: 0, pending: 0 };
  for (const c of calls) {
    s.calls++;
    if (c.receiptStatus === 'executed') s.ran++;
    else if (c.receiptStatus === 'not_executed') { s.didNotRun++; if (c.controlAction && c.controlAction !== 'allow') s.stoppedBySilex++; else s.didNotRunOther++; }
    else if (c.receiptStatus === 'failed') s.failed++;
    else s.pending++;
  }
  return s;
}

/**
 * Judge-signal line (plan U6): the judge's answers for a step, always labelled uncalibrated and non-blocking.
 * Uses the realtime evaluation, else a diagnostic one. Noul → raw probability, score → score, choice → choice.
 * Returns null when no evaluation answered anything.
 */
export function signalsLine(evaluations) {
  const list = Array.isArray(evaluations) ? evaluations : [];
  const ev = list.find(e => e.kind === 'realtime' && e.signals && Object.keys(e.signals).length)
    ?? list.find(e => e.kind === 'diagnostic' && e.signals && Object.keys(e.signals).length);
  if (!ev) return null;
  const fmt = s => (typeof s.raw_probability === 'number' ? s.raw_probability.toFixed(2)
    : typeof s.score === 'number' ? `score ${s.score.toFixed(2)}` : s.choice != null ? String(s.choice) : '—');
  const parts = Object.entries(ev.signals).map(([q, s]) => `${q} ${fmt(s ?? {})}`);
  return { label: `judge signals (uncalibrated, never block${ev.kind === 'diagnostic' ? '; diagnostic, after the decision' : ''})`, text: parts.join(' · ') };
}
