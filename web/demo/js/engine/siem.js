// SIEM JSONL sink formatter (T1). One JSON line per envelope: identifiers,
// decision fields and simulated-latency only — no raw text, no args
// (CONTRACT §3).

export function toSiemLine(envelope) {
  return JSON.stringify({
    trace_id: envelope.trace_id,
    span_id: envelope.span_id,
    event_id: envelope.event_id,
    t_ms: envelope.t_ms,
    boundary: envelope.boundary,
    tool: envelope.tool?.name ?? null,
    decision: envelope.decision,
    action: envelope.action,
    would_have: envelope.would_have ?? null,
    decided_by: envelope.decided_by,
    rule_ids: envelope.rule_hits.map(h => h.id),
    fallback_level: envelope.fallback_level,
    judge: envelope.judge,
    policy_version: envelope.policy_version,
    decision_latency_ms: envelope.decision_latency_ms,
    simulated: true,
  });
}
