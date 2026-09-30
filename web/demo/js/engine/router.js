// Router (T1): the state → action → outcome control loop (R p.6, p.12–14).
// One pure route() per span; runStream threads history; createEngine is the
// stateful UI wrapper.

import { batteryFor, makeEnvelope, LATENCY_BUDGET, DECISION } from './types.js';
import { buildState } from './state.js';
import { checkRules } from './rules.js';
import { judgeBattery } from './jev-sim.js';
import { judgeSlow } from './llm-sim.js';
import { combine, toolConfig } from './policy.js';
import { rngFor } from './rng.js';
import { scenarioById } from './scenarios.js';

const ACTION = {
  ALLOW: 'allow',
  REVIEW: 'hold_for_review',
  HOLD: 'hold_for_approval',
  BLOCK: 'deny',
  ALERT: 'review_ticket',
  STOP: 'stop_and_handover',
};

function actionFor(decision, mode, alert) {
  if (mode === 'monitor') return alert ? 'allow_and_alert' : 'allow';
  if (decision === 'ALLOW' && alert) return 'allow_and_alert';
  return ACTION[decision] ?? 'allow';
}

const policyLatency = (seed, spanId) =>
  Math.round(rngFor(seed, spanId, 'policy-latency').uniform(LATENCY_BUDGET.policy[0], LATENCY_BUDGET.policy[1]));

export function route(span, ctx) {
  if (!span || span.boundary == null) return null;
  const { tenant, policy, seed } = ctx;
  const history = ctx.history ?? [];
  const state = buildState(span, history, tenant, span.t_ms ?? 0);
  const rules = checkRules(state, tenant);

  const fault = span.fault ?? ctx.faults?.jev ?? null;
  const questions = batteryFor(state.boundary, { reduced: fault === 'rtt_spike', agent: span.agent ?? null });
  const deadline_ms = policy.deadline_ms ?? 400;
  const jev = judgeBattery(state.safeView, questions, { seed, spanId: span.span_id, deadline_ms, fault });
  const jev_on_critical_path = !rules.verdict;

  const combined = combine(state, rules, jev, policy, { tenant });
  const tc = toolConfig(policy, state.tool?.name);
  const action = actionFor(combined.decision, tc.mode, combined.alert);
  const would_have = tc.mode === 'monitor' ? combined.decision : null;

  const rules_ms = rules.latency_ms;
  const serialize_ms = jev_on_critical_path ? jev.serialize_ms : 0;
  const jev_ms = jev_on_critical_path ? Math.min(jev.latency_ms, deadline_ms) : 0;
  const policy_ms = policyLatency(seed, span.span_id);
  const decision_latency_ms = rules_ms + serialize_ms + jev_ms + policy_ms;

  const escalation = combined.escalate
    ? judgeSlow(state.safeView, { seed, spanId: span.span_id, reason: combined.escalate_reason })
    : null;

  return makeEnvelope({
    trace_id: span.trace_id,
    span_id: span.span_id,
    event_id: state.event_id,
    t_ms: span.t_ms ?? 0,
    boundary: state.boundary,
    agent: span.agent ?? null,
    tool: state.tool,
    judge: jev.version,
    answers: jev.answers,
    jev_status: jev.status,
    jev_on_critical_path,
    risk: combined.risk,
    policy_version: policy.version,
    mode: tc.mode,
    decision: combined.decision,
    action,
    would_have,
    decided_by: combined.decided_by,
    reasons: combined.reasons,
    rule_hits: rules.hits,
    fallback: combined.fallback,
    fallback_level: combined.fallback_level,
    alert: combined.alert,
    decision_latency_ms,
    latency_breakdown: { rules: rules_ms, serialize: serialize_ms, jev: jev_ms, policy: policy_ms },
    evidence_refs: state.evidence_refs,
    features: state.features,
    escalation,
    tokens_in: jev.tokens_in,
    cost_usd: jev.cost_usd,
    label: span.label ?? null,
    scenario: span.scenario ?? null,
  });
}

export function runStream(spans, ctx) {
  const history = [...(ctx.history ?? [])]; // continue an existing log (per-trace filtering happens in buildState)
  const out = [];
  for (const span of spans) {
    const env = route(span, { ...ctx, history });
    if (env) { history.push(env); out.push(env); }
  }
  return out;
}

function normalizeFaults(faults) {
  if (faults == null) return null;
  if (typeof faults === 'string') return { jev: faults };
  return faults;
}

export function createEngine({ tenant, policy, seed }) {
  let currentPolicy = policy;
  let log = [];

  return {
    route(span, faults) {
      const env = route(span, { tenant, policy: currentPolicy, seed, history: log, faults: normalizeFaults(faults) });
      if (env) log.push(env);
      return env;
    },
    inject(scenarioId, faults) {
      const t = scenarioById(scenarioId);
      if (!t) return [];
      const envs = runStream(t.spans, {
        tenant, policy: currentPolicy, seed, history: log, faults: normalizeFaults(faults),
      });
      log.push(...envs);
      return envs;
    },
    log: () => [...log],
    reset() { log = []; },
    setPolicy(p) { currentPolicy = p; },
  };
}
