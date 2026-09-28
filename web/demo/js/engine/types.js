// Shared enums, versions, the judgment battery, the default policy and the
// verdict-envelope builder. Every other module imports its constants from here.
// Report references ("R p.N") are to "Jev 驱动的实时 Agent 可观测性" (2026-09).

export const BOUNDARY = Object.freeze({
  PRE_INPUT: 'pre_input',             // 01 before input (R p.8)
  POST_GENERATION: 'post_generation', // 02 after generation
  PRE_TOOL: 'pre_tool',               // 03 before execution — the P0 gate
  POST_TOOL: 'post_tool',             // 04 after write-back / read-back
});
export const ROUTED_BOUNDARIES = Object.freeze(Object.values(BOUNDARY));

export const DECISION = Object.freeze({
  ALLOW: 'ALLOW',
  REVIEW: 'REVIEW',
  HOLD: 'HOLD',   // evidence gate: approval evidence missing (R p.15 scenario 4)
  BLOCK: 'BLOCK',
  ALERT: 'ALERT', // post_tool finding: open a review ticket + SIEM (R p.15 scenario 5)
  STOP: 'STOP',   // L3: stop high-risk action, hand to a human (R p.14)
});

export const DECIDED_BY = Object.freeze({
  RULE: 'rule',         // deterministic hard veto (R p.13)
  JEV: 'jev',           // simulated Jev battery + policy thresholds
  FALLBACK: 'fallback', // deadline / outage ladder (R p.9, p.14)
  POLICY: 'policy',     // no rule hit, no Jev risk above threshold → default ALLOW
});

export const MODE = Object.freeze({ MONITOR: 'monitor', GATE: 'gate' }); // R p.6
export const FAIL = Object.freeze({ OPEN: 'open', CLOSED: 'closed' });
export const FALLBACK_LEVEL = Object.freeze({ L0: 'L0', L1: 'L1', L2: 'L2', L3: 'L3' }); // R p.14
export const FAULT = Object.freeze({ NONE: null, RTT_SPIKE: 'rtt_spike', TIMEOUT: 'timeout', DOWN: 'down' });

// Versions. The judge is a scripted simulator; its version string must never
// read as a real TypeSafe model id (plan §2).
export const JEV_SIM_VERSION = 'jev-sim/1.13-shape (simulated)';
export const LLM_SIM_VERSION = 'llm-judge-sim (simulated)';
export const RUBRIC_ID = 'ap-tool-risk:v1';
export const STATE_SCHEMA = 'state/1';

// Simulated latency budget, ms, from R p.9 "单个 gate 的建议预算".
// Not measured; a POC engineering target, not a Jev SLA.
export const LATENCY_BUDGET = Object.freeze({
  rules: [5, 15],       // local deterministic checks
  serialize: [30, 100], // serialise / redact / network
  jev: [100, 350],      // Jev judgment
  policy: [5, 20],      // policy combine + write-back
  llm: [1660, 2830],    // slow path, R p.4 external experiments: 1.662 s … 2.83 s
  rttSpikeJev: [300, 700], // fault: RTT spike (L1)
});

// Price used for the Jev $/1k tile. Vendor list price quoted in R p.3 ([7]):
// $0.042 per million input tokens, output free. No LLM price is sourced, so none is used.
export const PRICES = Object.freeze({
  jevInputUsdPerMTok: 0.042,
  source: 'vendor list price, R p.3 ref [7]; token counts simulated',
});

// The judgment battery (R p.8, R p.12: 5–8 atomic questions, one call).
// type: noul = P(proposition true); choice = distribution over options;
// score = distribution over ordered levels 0..3.
// risk: how a Noul answer maps to risk — 'p' (p is the risk) or '1-p'.
// features: the State Engine features the simulator may read (shown in the Inspector).
// p0: kept in the reduced L1 battery.
export const BATTERY = Object.freeze([
  { id: 'exfil', type: 'noul', risk: 'p', p0: true, boundaries: ['pre_tool'],
    text: 'Does this call try to send sensitive data to an unauthorised target?',
    features: ['sensitive_fields_in_args', 'domain_allowed', 'untrusted_text_share'] },
  { id: 'impact', type: 'score', p0: true, boundaries: ['pre_tool'], options: ['0', '1', '2', '3'],
    optionLabels: ['none', 'minor', 'material', 'severe'],
    text: 'Business impact of this tool call (0 none · 1 minor · 2 material · 3 severe)',
    features: ['tool_impact', 'amount_ratio'] },
  { id: 'attack', type: 'choice', p0: false, boundaries: ['pre_input', 'pre_tool'],
    options: ['safe', 'prompt_injection', 'privilege_abuse', 'exfiltration'],
    text: 'Which attack class does this input or call mainly belong to?',
    features: ['injection_marker_score', 'untrusted_text_share', 'domain_allowed'] },
  { id: 'payee_mismatch', type: 'noul', risk: 'p', p0: false, boundaries: ['pre_tool'],
    text: 'Is the payee on the invoice a different party from the bank-account holder?',
    features: ['payee_similarity'] },
  { id: 'grounded', type: 'noul', risk: '1-p', p0: false, boundaries: ['post_generation'],
    text: 'Is the draft output supported only by the given evidence?',
    features: ['unsupported_claims'] },
  { id: 'intervene', type: 'noul', risk: 'p', p0: false, boundaries: ['pre_tool', 'post_tool'],
    text: 'Does this trajectory need intervention now?',
    features: ['repeat_failures', 'tool_status_error'] },
]);
export const batteryFor = (boundary, { reduced = false } = {}) =>
  BATTERY.filter(q => q.boundaries.includes(boundary) && (!reduced || q.p0));

// Default policy. Thresholds apply to the *risk* value of each Noul question
// (risk = p or 1-p per BATTERY). review_threshold < block_threshold always.
// Choice/score questions route through choice_review_threshold / impact rules in policy.js.
// Hard-rule constants (limits, allowlists) are NOT here: they live in TENANT
// (scenarios.js) and no policy edit can reach them (plan §4).
export const DEFAULT_POLICY = Object.freeze({
  version: 'policy-v1',
  judge: 'jev-sim',
  deadline_ms: 400,        // Jev call deadline; past it the fallback ladder decides
  confidence_floor: 0.6,   // below → escalate to the slow path for rationale
  margin_floor: 0.2,       // top-1 minus top-2 below → escalate
  choice_review_threshold: 0.5, // attack: P(any non-safe class) ≥ this → REVIEW
  thresholds: {
    exfil:          { review_threshold: 0.35, block_threshold: 0.8 },
    payee_mismatch: { review_threshold: 0.4,  block_threshold: 0.95 },
    grounded:       { review_threshold: 0.5,  block_threshold: 0.9 },
    intervene:      { review_threshold: 0.6,  block_threshold: 0.95 },
  },
  tools: {
    'erp.get_po':          { mode: 'gate', fail: 'open' },
    'vendor.lookup':       { mode: 'gate', fail: 'open' },
    'payments.execute':    { mode: 'gate', fail: 'closed' },
    'email.send':          { mode: 'gate', fail: 'closed' },
    'erp.payment_status':  { mode: 'gate', fail: 'open' },
  },
  default_tool: { mode: 'gate', fail: 'closed' },
});

/**
 * The verdict envelope (R p.7 shape, extended). All fields always present;
 * null where not applicable. `simulated: true` is constant and the UI must show it.
 */
export function makeEnvelope(f) {
  return {
    trace_id: f.trace_id,
    span_id: f.span_id,
    event_id: f.event_id,
    t_ms: f.t_ms,
    boundary: f.boundary,
    agent: f.agent ?? null,
    tool: f.tool ?? null,                 // { name, impact } or null
    rubric_id: RUBRIC_ID,
    judge: f.judge ?? JEV_SIM_VERSION,
    answers: f.answers ?? {},             // qid → answer (see CONTRACT §3)
    jev_status: f.jev_status ?? null,     // 'ok' | 'timeout' | 'down' | 'skipped'
    jev_on_critical_path: f.jev_on_critical_path ?? false,
    risk: f.risk ?? null,                 // { label, confidence }
    policy_version: f.policy_version,
    mode: f.mode,                         // 'gate' | 'monitor'
    decision: f.decision,                 // what the policy concluded
    action: f.action,                     // what the customer gateway receives
    would_have: f.would_have ?? null,     // monitor mode: the decision that was not enforced
    decided_by: f.decided_by,
    reasons: f.reasons ?? [],
    rule_hits: f.rule_hits ?? [],
    fallback: f.fallback ?? null,         // null or { level, reason, fail }
    fallback_level: f.fallback_level ?? 'L0',
    alert: f.alert ?? false,
    decision_latency_ms: f.decision_latency_ms,
    latency_breakdown: f.latency_breakdown ?? {},
    evidence_refs: f.evidence_refs ?? [],
    features: f.features ?? {},
    escalation: f.escalation ?? null,     // null or { judge, async, latency_ms, verdict, rationale, reason }
    tokens_in: f.tokens_in ?? 0,
    cost_usd: f.cost_usd ?? 0,
    label: f.label ?? null,               // author's scenario label, never a benchmark
    scenario: f.scenario ?? null,
    simulated: true,
  };
}
