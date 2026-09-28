// Simulated slow path (T1): a single-thread LLM judge for escalation rationale
// (R p.13). Latency from the report's measured 1.66–2.83 s range; no cost is
// sourced, so none is reported.

import { LLM_SIM_VERSION, LATENCY_BUDGET } from './types.js';
import { rngFor } from './rng.js';

const FEATURE_ORDER = [
  'payee_similarity', 'amount_ratio', 'injection_marker_score', 'domain_allowed',
  'unsupported_claims', 'repeat_failures', 'tool_status_error',
];

function summarize(features) {
  const parts = [];
  for (const k of FEATURE_ORDER) {
    const v = features[k];
    if (v == null) continue;
    parts.push(`${k}=${typeof v === 'number' ? Math.round(v * 1000) / 1000 : v}`);
  }
  return parts.length ? parts.join(', ') : 'no notable features';
}

export function judgeSlow(safeView, { seed, spanId, reason }) {
  const r = rngFor(seed, spanId, 'llm');
  const latency_ms = Math.round(r.uniform(LATENCY_BUDGET.llm[0], LATENCY_BUDGET.llm[1]));
  const tokens_in = Math.ceil(JSON.stringify(safeView).length / 4);
  const tokens_out = Math.round(r.uniform(60, 180));
  return {
    judge: LLM_SIM_VERSION,
    async: true,
    latency_ms,
    verdict: 'REVIEW',
    rationale: `Simulated rationale: ${summarize(safeView.features)}`,
    reason: reason ?? null,
    tokens_in,
    tokens_out,
  };
}
