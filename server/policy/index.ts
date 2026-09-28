// Policy compiler (RFC §7, plan §4). Risk conclusion and action are separate:
// `recommended` is the risk conclusion; `would_have` / `enforced_action` are actions.
// Gate A is shadow-only: enforced_action is always null.
import { z } from 'zod';
import type { DecisionSnapshot } from '../../contracts/snapshot.ts';
import type { EvaluationRecord, Signal } from '../../contracts/judge.ts';
import type { PolicyDecision, Recommendation, RuleResult } from '../../contracts/decision.ts';
import type { Boundary, Impact, Provenance } from '../../contracts/common.ts';

export const PolicyBody = z.object({
  policy_version: z.string().min(1),
  rubric_id: z.string(),
  judge_deadline_ms: z.number().int().min(50).max(10_000),     // realtime judge budget per call
  realtime_ttl_ms: z.number().int().min(1_000).max(600_000),   // shadow job expires after this (RFC §6.5)
  judge_view_max_tokens: z.number().int().min(128).max(32_768),
  semantic: z.object({
    /**
     * 'experimental': signals are recorded and bands shown, but never change `recommended`.
     * 'calibrated': requires a calibration_id that exists for this judge_source (Gate B). Gate A has none,
     *  so validate() rejects 'calibrated'.
     */
    mode: z.enum(['experimental', 'calibrated']),
    calibration_id: z.string().nullable(),
    /** Intervention band per question, on the question's risk value (noul p; choice: p of a named option). */
    bands: z.record(z.string(), z.object({
      risk_option: z.string().nullable(),     // for choice questions: which option counts as risk
      review_at: z.number().min(0).max(1),
    })),
  }),
});
export type PolicyBody = z.infer<typeof PolicyBody>;

export const DEFAULT_POLICY: PolicyBody = {
  policy_version: 'policy-a1',
  rubric_id: 'ap-runtime-semantic:v1',
  judge_deadline_ms: 3_000,          // Kev on Apple Silicon: hundreds of ms warm, ~2 s cold (runs/spike-2026-09-28)
  realtime_ttl_ms: 60_000,
  judge_view_max_tokens: 1_024,      // plan D6
  semantic: {
    mode: 'experimental',
    calibration_id: null,
    bands: {
      instruction_override: { risk_option: null, review_at: 0.5 },
      goal_deviation: { risk_option: null, review_at: 0.5 },
      sensitive_data_transfer: { risk_option: null, review_at: 0.5 },
      payee_relation: { risk_option: 'different_entity', review_at: 0.5 },
      claim_support: { risk_option: 'contradicted', review_at: 0.5 },
    },
  },
};

export function validatePolicy(input: unknown, known: { calibrations: string[] } = { calibrations: [] }):
  { ok: true; policy: PolicyBody } | { ok: false; errors: string[] } {
  const r = PolicyBody.safeParse(input);
  if (!r.success) return { ok: false, errors: r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
  const p = r.data;
  if (p.semantic.mode === 'calibrated' && (!p.semantic.calibration_id || !known.calibrations.includes(p.semantic.calibration_id)))
    return { ok: false, errors: ['semantic.mode calibrated requires an existing calibration_id (none exist before Gate B eval)'] };
  return { ok: true, policy: p };
}

/** Risk value a band compares against; null if the signal can't be read that way. */
export function riskValue(s: Signal, band: { risk_option: string | null }): number | null {
  if (s.type === 'noul') return s.raw_probability;
  if (band.risk_option && s.probabilities) return s.probabilities[band.risk_option] ?? null;
  return null;
}

const SEVERITY: Record<RuleResult['verdict'], number> = { PASS: 0, ALERT: 1, HOLD: 2, BLOCK: 3, STOP: 4 };
const worst = (rs: RuleResult[]) => rs.reduce<RuleResult['verdict']>((w, r) => (SEVERITY[r.verdict] > SEVERITY[w] ? r.verdict : w), 'PASS');

export function wouldHaveAction(rec: Recommendation, boundary: Boundary): string | null {
  // Completed boundaries cannot be allowed or denied after the fact (RFC §7).
  if (boundary === 'post_tool' || boundary === 'post_generation' || boundary === 'outcome_observed')
    return rec === 'NO_CONFIGURED_RISK' ? null : 'open_investigation';
  switch (rec) {
    case 'REJECT': case 'BLOCK': return 'deny';
    case 'STOP': return 'stop_and_handover';
    case 'HOLD': return 'hold_for_approval';
    case 'UNKNOWN': case 'REVIEW': return 'hold_for_review';
    case 'ALERT': return 'allow_and_alert';
    case 'NO_CONFIGURED_RISK': return 'allow';
  }
}

export interface DecideInput {
  snapshot: DecisionSnapshot;
  rules: RuleResult[];
  evaluation: EvaluationRecord | null;     // null when the judge was skipped (hard rule decided)
  policy: PolicyBody;
  provenance: Provenance;
  decisionId: string;
  timings: PolicyDecision['timings'];
  now: string;
}

/** RFC §7 order. Pure. */
export function decide(inp: DecideInput): PolicyDecision {
  const { snapshot: s, rules, evaluation: ev, policy } = inp;
  const reasons: string[] = [];
  const gaps: string[] = [];
  const impact = (s.candidate_action?.impact ?? null) as Impact | null;
  const highImpact = impact === 'payment' || impact === 'write';
  let recommended: Recommendation = 'NO_CONFIGURED_RISK';
  let decidedBy: PolicyDecision['decided_by'] = 'default';

  // Semantic hits are always computed for display; they only drive the result when calibrated.
  const hits: PolicyDecision['semantic']['hits'] = [];
  if (ev) for (const [qid, sig] of Object.entries(ev.signals)) {
    const band = policy.semantic.bands[qid];
    if (!band) continue;
    const v = riskValue(sig, band);
    if (v == null) continue;
    hits.push({ question_id: qid, value: v, band: v >= band.review_at ? (policy.semantic.mode === 'calibrated' ? 'review' : 'experimental_review') : 'below' });
  }

  const w = worst(rules);
  const ruleHits = rules.filter(r => r.verdict !== 'PASS');
  if (w === 'STOP' || w === 'BLOCK' || w === 'HOLD') {
    // Step 2: authoritative hard rule; no model output can change this.
    recommended = w; decidedBy = 'rule';
    reasons.push(...ruleHits.map(r => `${r.rule_id}: ${r.reason}`));
  } else if (s.missing_evidence.length || s.stale_evidence.length) {
    // Step 3: required evidence missing or stale → HOLD (high impact) / UNKNOWN.
    recommended = highImpact ? 'HOLD' : 'UNKNOWN'; decidedBy = 'evidence_gate';
    reasons.push(...s.missing_evidence.map(e => `missing evidence: ${e}`), ...s.stale_evidence.map(e => `stale evidence: ${e}`));
  } else {
    const required = ev?.required_question_ids ?? [];
    const missingRequired = !ev ? [] : required.filter(q => !ev.signals[q]);
    const judgeFailed = ev != null && ev.status !== 'ok' && ev.status !== 'partial';
    if (ev && (judgeFailed || missingRequired.length)) {
      // Step 4: required signal unavailable → degrade by the registry impact floor, never "safe".
      gaps.push(judgeFailed ? `judge ${ev.status}` : `required signals missing: ${missingRequired.join(', ')}`);
      if (highImpact) { recommended = 'HOLD'; decidedBy = 'judge_unavailable'; }
      else if (required.length || judgeFailed) { recommended = 'ALERT'; decidedBy = 'judge_unavailable'; }
      reasons.push(`required semantic signal unavailable (${gaps[0]}); not treated as low risk`);
    } else if (policy.semantic.mode === 'calibrated' && hits.some(h => h.band === 'review')) {
      // Step 5 (from Gate B): calibrated semantic signal in the intervention band.
      recommended = 'REVIEW'; decidedBy = 'semantic';
      reasons.push(...hits.filter(h => h.band === 'review').map(h => `${h.question_id} ${h.value.toFixed(3)} ≥ band`));
    } else {
      // Step 6: no configured risk found. Not "safe".
      if (w === 'ALERT') { recommended = 'ALERT'; decidedBy = 'rule'; reasons.push(...ruleHits.map(r => `${r.rule_id}: ${r.reason}`)); }
      const exp = hits.filter(h => h.band === 'experimental_review');
      if (exp.length) reasons.push(`uncalibrated signals above experimental band (not acted on): ${exp.map(h => `${h.question_id} ${h.value.toFixed(3)}`).join(', ')}`);
    }
  }
  if (ev && ev.status === 'partial') gaps.push('optional signals missing');

  const shadow = inp.provenance.enforcement_mode === 'shadow';
  const action = wouldHaveAction(recommended, s.boundary);
  return {
    decision_id: inp.decisionId,
    tenant_id: s.tenant_id,
    event_id: s.event_id,
    evaluation_id: ev?.evaluation_id ?? null,
    snapshot_id: s.snapshot_id,
    policy_version: policy.policy_version,
    provenance: inp.provenance,
    recommended,
    decided_by: decidedBy,
    would_have: shadow ? action : null,
    enforced_action: null,           // Gate A never enforces
    reasons,
    rule_results: rules,
    semantic: { calibrated: policy.semantic.mode === 'calibrated', hits },
    coverage_gaps: gaps,
    timings: inp.timings,
    created_at: inp.now,
  };
}
