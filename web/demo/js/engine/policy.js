// Policy engine + fallback ladder (T1). Decision order R p.9 / p.13: first
// match wins. Thresholds apply to the *risk* value of each Noul question.

import { DECISION, MODE, FAIL, BATTERY } from './types.js';

const SEVERITY = { STOP: 6, BLOCK: 5, HOLD: 4, ALERT: 3, REVIEW: 2, ALLOW: 1 };

export function validatePolicy(policy) {
  const errors = [];
  const thresholds = policy?.thresholds ?? {};
  for (const [qid, t] of Object.entries(thresholds)) {
    const r = t?.review_threshold;
    const b = t?.block_threshold;
    if (typeof r !== 'number' || typeof b !== 'number') {
      errors.push(`${qid}: review_threshold and block_threshold must be numbers`);
      continue;
    }
    if (r < 0 || r > 1) errors.push(`${qid}.review_threshold must be in [0,1]`);
    if (b < 0 || b > 1) errors.push(`${qid}.block_threshold must be in [0,1]`);
    if (r >= b) errors.push(`${qid}: review_threshold (${r}) must be < block_threshold (${b})`);
  }
  const checkTool = (name, t) => {
    if (t == null) return;
    if (![MODE.MONITOR, MODE.GATE].includes(t.mode)) errors.push(`${name}: unknown mode "${t.mode}"`);
    if (![FAIL.OPEN, FAIL.CLOSED].includes(t.fail)) errors.push(`${name}: unknown fail "${t.fail}"`);
  };
  for (const [name, t] of Object.entries(policy?.tools ?? {})) checkTool(name, t);
  checkTool('default_tool', policy?.default_tool);
  return { ok: errors.length === 0, errors };
}

export function toolConfig(policy, toolName) {
  if (!toolName) return { mode: MODE.GATE, fail: FAIL.OPEN };
  const t = policy?.tools?.[toolName] ?? policy?.default_tool;
  return { mode: t?.mode ?? MODE.GATE, fail: t?.fail ?? FAIL.CLOSED };
}

function riskFromAnswers(answers) {
  let best = null;
  for (const a of Object.values(answers)) {
    let signal = null;
    let conf = null;
    if (a.type === 'noul') { signal = a.risk; conf = a.confidence; }
    else if (a.type === 'choice') { signal = 1 - (a.dist.safe ?? 0); conf = a.confidence; }
    if (signal == null) continue;
    if (!best || signal > best.signal) best = { signal, conf };
  }
  if (!best) return null;
  const label = best.signal >= 0.8 ? 'high' : best.signal >= 0.35 ? 'medium' : 'low';
  return { label, confidence: best.conf };
}

export function combine(state, rules, jev, policy, { tenant }) {
  const { fail } = toolConfig(policy, state.tool?.name);

  let fallback = null;
  let fallback_level = 'L0';
  if (state.stale) fallback_level = 'L3';
  else if (jev.status === 'timeout' || jev.status === 'down') fallback_level = 'L2';
  else if (jev.reduced) fallback_level = 'L1';

  // 1. Hard rules (R p.13) — Jev is advisory only.
  if (rules.verdict) {
    if (state.stale) fallback = { level: 'L3', reason: 'stale state snapshot', fail };
    return {
      decision: rules.verdict,
      decided_by: 'rule',
      reasons: rules.hits.map(h => h.reason),
      fallback,
      fallback_level,
      alert: false,
      escalate: false,
      escalate_reason: null,
      risk: riskFromAnswers(jev.answers),
    };
  }

  // 2. Jev unavailable — fallback ladder L2 (R p.9: no answer ≠ safe).
  if (jev.status === 'timeout' || jev.status === 'down') {
    const closed = fail === FAIL.CLOSED;
    const decision = closed ? DECISION.BLOCK : DECISION.ALLOW;
    const alert = !closed;
    fallback = { level: 'L2', reason: jev.status === 'timeout' ? 'jev timeout' : 'jev down', fail };
    return {
      decision,
      decided_by: 'fallback',
      reasons: [`Jev ${jev.status}; fail-${fail} → ${decision}`],
      fallback,
      fallback_level: 'L2',
      alert,
      escalate: false,
      escalate_reason: null,
      risk: null,
    };
  }

  // 3. Jev thresholds / battery (R p.10). Most severe wins.
  let decision = DECISION.ALLOW;
  let decided_by = 'policy';
  const reasons = [];

  for (const q of BATTERY) {
    const ans = jev.answers[q.id];
    if (!ans) continue;
    if (q.type === 'noul') {
      const t = policy?.thresholds?.[q.id];
      if (!t) continue;
      if (ans.risk >= t.block_threshold) {
        if (SEVERITY[decision] < SEVERITY[DECISION.BLOCK]) decision = DECISION.BLOCK;
        reasons.push(`${q.id}: risk ${ans.risk} ≥ block ${t.block_threshold}`);
      } else if (ans.risk >= t.review_threshold) {
        if (SEVERITY[decision] < SEVERITY[DECISION.REVIEW]) decision = DECISION.REVIEW;
        reasons.push(`${q.id}: risk ${ans.risk} ≥ review ${t.review_threshold}`);
      }
    } else if (q.type === 'choice' && q.id === 'attack') {
      const nonSafe = 1 - (ans.dist.safe ?? 0);
      const thr = policy.choice_review_threshold ?? 0.5;
      if (nonSafe >= thr) {
        if (SEVERITY[decision] < SEVERITY[DECISION.REVIEW]) decision = DECISION.REVIEW;
        reasons.push(`attack: P(non-safe) ${nonSafe} ≥ ${thr}`);
      }
    }
  }

  if (decision !== DECISION.ALLOW) decided_by = 'jev';

  // 4. Escalation (R p.13) — never changes the decision.
  let escalate = false;
  let escalate_reason = null;
  if (decided_by === 'jev' && decision === DECISION.REVIEW) {
    escalate = true;
    escalate_reason = 'Jev review band';
  } else {
    for (const ans of Object.values(jev.answers)) {
      if (ans.confidence < (policy.confidence_floor ?? 0)) {
        escalate = true; escalate_reason = `low confidence (${ans.confidence})`; break;
      }
      if (ans.margin < (policy.margin_floor ?? 0)) {
        escalate = true; escalate_reason = `narrow margin (${ans.margin})`; break;
      }
    }
  }

  return {
    decision,
    decided_by,
    reasons,
    fallback,
    fallback_level,
    alert: false,
    escalate,
    escalate_reason,
    risk: riskFromAnswers(jev.answers),
  };
}
