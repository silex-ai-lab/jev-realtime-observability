// KPI computation from the decision log (T1). Every number derives from the
// envelopes themselves; the labels are the demo author's scenario labels
// (plan §2: "scenario labels — not a benchmark").

const BLOCKING = new Set(['BLOCK', 'HOLD', 'STOP']);

export function percentile(values, q) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(q * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

export function computeKpis(envelopes) {
  const routed = envelopes.length;
  const preTool = envelopes.filter(e => e.boundary === 'pre_tool');

  const count = d => envelopes.filter(e => e.decision === d).length;
  const blocks = count('BLOCK');
  const holds = count('HOLD');
  const reviews = count('REVIEW');
  const alerts = count('ALERT');
  const stops = count('STOP');

  const lats = preTool.map(e => e.decision_latency_ms);
  const p50_ms = percentile(lats, 0.5);
  const p95_ms = percentile(lats, 0.95);

  const review_rate = routed ? (reviews + holds + alerts + stops) / routed : 0;

  const labelledAllow = envelopes.filter(e => e.label?.expected === 'ALLOW');
  const falseBlocks = labelledAllow.filter(e => BLOCKING.has(e.decision)).length;
  const false_block_rate = labelledAllow.length ? falseBlocks / labelledAllow.length : 0;

  const labelledP0 = envelopes.filter(e => ['BLOCK', 'HOLD'].includes(e.label?.expected));
  const p0Caught = labelledP0.filter(e => BLOCKING.has(e.decision)).length;
  const p0_recall = labelledP0.length ? p0Caught / labelledP0.length : 0;

  const preToolDecided = preTool.filter(e => e.decision && e.decided_by).length;
  const coverage = preTool.length ? preToolDecided / preTool.length : 0;

  const jev_calls = routed;
  const okCalls = envelopes.filter(e => e.jev_status === 'ok');
  const totalCost = okCalls.reduce((s, e) => s + (e.cost_usd ?? 0), 0);
  const jev_cost_per_1k_usd = okCalls.length ? (totalCost / okCalls.length) * 1000 : 0;

  return {
    routed,
    pre_tool: preTool.length,
    p50_ms,
    p95_ms,
    blocks,
    holds,
    reviews,
    alerts,
    stops,
    review_rate,
    false_block_rate,
    p0_recall,
    coverage,
    jev_calls,
    jev_cost_per_1k_usd,
    labelled_allow: labelledAllow.length,
    labelled_p0: labelledP0.length,
  };
}
