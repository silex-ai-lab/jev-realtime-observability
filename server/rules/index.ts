// T1 (deepseek). Authoritative deterministic checks (RFC §7 step 2, plan §4).
// Pure over snapshot.facts: the state assembler (T2) fills facts from authoritative
// sandbox records via AuthorityReader; rules never trust the agent's own claims.
import type { DecisionSnapshot } from '../../contracts/snapshot.ts';
import type { RuleResult, RuleVerdict } from '../../contracts/decision.ts';

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

const SEVERITY: Record<RuleVerdict, number> = { STOP: 4, BLOCK: 3, HOLD: 2, ALERT: 1, PASS: 0 };

type Fact = boolean | string | number | null | undefined;
const num = (v: Fact): v is number => typeof v === 'number' && Number.isFinite(v);

const result = (rule_id: RuleId, verdict: RuleVerdict, reason: string, evidence_refs: string[], authoritative_source: string): RuleResult =>
  ({ rule_id, verdict, reason, evidence_refs, authoritative_source });

function oneRule(id: RuleId, f: Record<string, Fact>): RuleResult {
  switch (id) {
    case 'unknown_tool': {
      // Applicable only when there is a candidate action (tool_impact non-null).
      if (f.tool_impact === null || f.tool_impact === undefined) return result(id, 'PASS', 'no candidate action to check', ['facts:tool_impact'], 'registry.tools');
      if (f.tool_known === false) return result(id, 'HOLD', 'tool not present in the tool registry', ['facts:tool_known'], 'registry.tools');
      if (f.tool_known === true) return result(id, 'PASS', 'tool present in the tool registry', ['facts:tool_known'], 'registry.tools');
      return result(id, 'HOLD', 'required fact missing: tool_known', ['facts:tool_known'], 'registry.tools');
    }
    case 'stale_state': {
      if (!num(f.snapshot_age_ms) || !num(f.stale_after_ms))
        return result(id, 'HOLD', 'required fact missing: snapshot_age_ms / stale_after_ms', ['facts:snapshot_age_ms', 'facts:stale_after_ms'], 'sandbox.events');
      if (f.snapshot_age_ms > f.stale_after_ms) return result(id, 'STOP', `stale state: snapshot age ${f.snapshot_age_ms}ms exceeds limit ${f.stale_after_ms}ms`, ['facts:snapshot_age_ms', 'facts:stale_after_ms'], 'sandbox.events');
      return result(id, 'PASS', 'state is fresh', ['facts:snapshot_age_ms', 'facts:stale_after_ms'], 'sandbox.events');
    }
    case 'repeat_failure': {
      if (!num(f.prior_tool_failures) || !num(f.repeat_failure_n))
        return result(id, 'HOLD', 'required fact missing: prior_tool_failures / repeat_failure_n', ['facts:prior_tool_failures', 'facts:repeat_failure_n'], 'sandbox.events');
      if (f.prior_tool_failures >= f.repeat_failure_n) return result(id, 'STOP', `${f.prior_tool_failures} prior tool failures reached the limit ${f.repeat_failure_n}`, ['facts:prior_tool_failures', 'facts:repeat_failure_n'], 'sandbox.events');
      return result(id, 'PASS', 'prior failures under the repeat-failure limit', ['facts:prior_tool_failures', 'facts:repeat_failure_n'], 'sandbox.events');
    }
    case 'amount_limit': {
      if (f.tool_impact === null || f.tool_impact === undefined) return result(id, 'PASS', 'no candidate action to check', ['facts:tool_impact'], 'sandbox.tenant_policy');
      if (f.tool_impact !== 'payment') return result(id, 'PASS', `not a payment action (impact ${f.tool_impact})`, ['facts:tool_impact'], 'sandbox.tenant_policy');
      if (!num(f.amount_usd)) return result(id, 'HOLD', 'required fact missing: amount_usd', ['facts:amount_usd'], 'sandbox.tenant_policy');
      if (!num(f.approval_limit_usd)) return result(id, 'HOLD', 'required fact missing: approval_limit_usd', ['facts:approval_limit_usd'], 'sandbox.tenant_policy');
      if (f.amount_usd > f.approval_limit_usd) return result(id, 'BLOCK', `amount ${f.amount_usd} exceeds the approval limit ${f.approval_limit_usd}`, ['facts:amount_usd', 'facts:approval_limit_usd'], 'sandbox.tenant_policy');
      return result(id, 'PASS', `amount ${f.amount_usd} within the approval limit ${f.approval_limit_usd}`, ['facts:amount_usd', 'facts:approval_limit_usd'], 'sandbox.tenant_policy');
    }
    case 'domain_allowlist': {
      if (f.dest_domain === null || f.dest_domain === undefined) return result(id, 'PASS', 'no destination domain to check', ['facts:dest_domain'], 'sandbox.tenant_policy');
      if (f.domain_allowed === null || f.domain_allowed === undefined) return result(id, 'HOLD', 'required fact missing: domain_allowed', ['facts:dest_domain', 'facts:domain_allowed'], 'sandbox.tenant_policy');
      if (f.domain_allowed === false) return result(id, 'BLOCK', `destination domain ${f.dest_domain} is not in the allowlist`, ['facts:dest_domain', 'facts:domain_allowed'], 'sandbox.tenant_policy');
      return result(id, 'PASS', `destination domain ${f.dest_domain} is allowlisted`, ['facts:dest_domain', 'facts:domain_allowed'], 'sandbox.tenant_policy');
    }
    case 'approval_evidence': {
      if (f.tool_impact === null || f.tool_impact === undefined) return result(id, 'PASS', 'no candidate action to check', ['facts:tool_impact'], 'sandbox.erp.approvals');
      if (f.tool_impact !== 'payment') return result(id, 'PASS', `not a payment action (impact ${f.tool_impact})`, ['facts:tool_impact'], 'sandbox.erp.approvals');
      if (f.approval_status === null || f.approval_status === undefined) return result(id, 'HOLD', 'required fact missing: approval_status', ['facts:approval_status'], 'sandbox.erp.approvals');
      if (f.approval_status === 'approved') return result(id, 'PASS', 'payment has an approved approval', ['facts:approval_status'], 'sandbox.erp.approvals');
      return result(id, 'HOLD', `payment without an approved approval (approval_status=${f.approval_status})`, ['facts:approval_status'], 'sandbox.erp.approvals');
    }
  }
}

/**
 * Returns one RuleResult per rule (PASS included, so the UI can show what was checked).
 * unknown_tool → HOLD · stale_state → STOP · repeat_failure → STOP · amount_limit → BLOCK ·
 * domain_allowlist → BLOCK · approval_evidence (payment without approval_status 'approved') → HOLD.
 * A fact that is null where a rule needs it yields HOLD with reason "required fact missing", never PASS.
 */
export function evaluateRules(snapshot: DecisionSnapshot): RuleResult[] {
  const f = snapshot.facts as Record<string, Fact>;
  return RULE_IDS.map(id => oneRule(id, f));
}

/** Most severe verdict: STOP > BLOCK > HOLD > ALERT > PASS. */
export function worstVerdict(results: RuleResult[]): RuleVerdict {
  let worst: RuleVerdict = 'PASS';
  for (const r of results) if (SEVERITY[r.verdict] > SEVERITY[worst]) worst = r.verdict;
  return worst;
}
