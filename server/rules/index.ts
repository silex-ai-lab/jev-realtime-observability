// T1 (deepseek) implements. Authoritative deterministic checks (RFC §7 step 2, plan §4).
// Pure over snapshot.facts: the state assembler (T2) fills facts from authoritative
// sandbox records via AuthorityReader; rules never trust the agent's own claims.
import type { DecisionSnapshot } from '../../contracts/snapshot.ts';
import type { RuleResult } from '../../contracts/decision.ts';

/**
 * Fact keys the state assembler provides (null = not applicable or not available):
 *   tool_impact            'read'|'write'|'payment'|null   (registry floor)
 *   amount_usd             number|null                     (from tool args, parsed by code)
 *   approval_limit_usd     number|null                     (authority: tenant policy)
 *   approval_status        'approved'|'pending'|'rejected'|'missing'|null  (authority: sandbox.approvals)
 *   approval_ref           string|null
 *   dest_domain            string|null                     (email recipient / remit domain)
 *   domain_allowed         boolean|null                    (authority: tenant allowlist)
 *   prior_tool_failures    number                          (same run, from stored events)
 *   repeat_failure_n       number                          (authority: tenant policy)
 *   snapshot_age_ms        number                          (as_of − occurred_at of the triggering event)
 *   stale_after_ms         number                          (authority: tenant policy)
 *   tool_known             boolean                         (tool present in registry)
 */
export const RULE_IDS = ['unknown_tool', 'stale_state', 'repeat_failure', 'amount_limit', 'domain_allowlist', 'approval_evidence'] as const;
export type RuleId = typeof RULE_IDS[number];

/**
 * Returns one RuleResult per applicable rule (PASS included, so the UI can show what was checked).
 * unknown_tool → HOLD · stale_state → STOP · repeat_failure → STOP · amount_limit → BLOCK ·
 * domain_allowlist → BLOCK · approval_evidence (payment without approval_status 'approved') → HOLD.
 * A fact that is null where a rule needs it yields HOLD with reason "required fact missing", never PASS.
 */
export function evaluateRules(snapshot: DecisionSnapshot): RuleResult[] {
  throw new Error('evaluateRules: not implemented (T1)');
}

/** Most severe verdict: STOP > BLOCK > HOLD > ALERT > PASS. */
export function worstVerdict(results: RuleResult[]): RuleResult['verdict'] {
  throw new Error('worstVerdict: not implemented (T1)');
}
