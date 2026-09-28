// One test per rule, each including the null-fact → HOLD case, plus the scenario outcomes
// (S1 all PASS, S3 amount_limit BLOCK, S4 approval_evidence HOLD, S6 domain_allowlist BLOCK).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULE_IDS, evaluateRules, worstVerdict } from '../../../server/rules/index.ts';
import type { DecisionSnapshot } from '../../../contracts/snapshot.ts';
import type { RuleVerdict } from '../../../contracts/decision.ts';

const facts = (over: Record<string, unknown> = {}) => ({
  tool_known: true, tool_impact: 'payment', amount_usd: 8420, approval_limit_usd: 25000,
  approval_status: 'approved', approval_ref: 'APR-1', dest_domain: 'bank.northwind.example',
  domain_allowed: true, prior_tool_failures: 0, repeat_failure_n: 3, snapshot_age_ms: 10, stale_after_ms: 5000,
  ...over,
});

const snap = (f: Record<string, unknown>): DecisionSnapshot => ({
  snapshot_id: 'snap-1', tenant_id: 't-alpha', run_id: 'run-1', event_id: 'ev-1', boundary: 'pre_tool',
  as_of: new Date().toISOString(), cutoff_seq: 1, extractor_version: 'test',
  task_goal: null, candidate_action: { tool: 'payments.execute', operation_id: 'op-1', impact: 'payment', args_summary: {} },
  history: [], evidence: [],
  facts: f as DecisionSnapshot['facts'],
  required_evidence: [], missing_evidence: [], stale_evidence: [],
  judge_view: { state: '', token_estimate: 0, truncated: false },
});

const verdictOf = (ruleId: string, f: Record<string, unknown>): RuleVerdict => {
  const r = evaluateRules(snap(f)).find(x => x.rule_id === ruleId)!;
  assert.ok(r, `rule ${ruleId} missing`);
  return r.verdict;
};

test('unknown_tool: unknown tool → HOLD; null fact → HOLD; known → PASS', () => {
  assert.equal(verdictOf('unknown_tool', facts({ tool_known: false })), 'HOLD');
  assert.equal(verdictOf('unknown_tool', facts({ tool_known: null })), 'HOLD');
  assert.equal(verdictOf('unknown_tool', facts({ tool_known: true })), 'PASS');
});

test('stale_state: stale → STOP; null fact → HOLD; fresh → PASS', () => {
  assert.equal(verdictOf('stale_state', facts({ snapshot_age_ms: 10_000, stale_after_ms: 5000 })), 'STOP');
  assert.equal(verdictOf('stale_state', facts({ stale_after_ms: null })), 'HOLD');
  assert.equal(verdictOf('stale_state', facts({ snapshot_age_ms: 10, stale_after_ms: 5000 })), 'PASS');
});

test('repeat_failure: repeated → STOP; null fact → HOLD; under limit → PASS', () => {
  assert.equal(verdictOf('repeat_failure', facts({ prior_tool_failures: 3, repeat_failure_n: 3 })), 'STOP');
  assert.equal(verdictOf('repeat_failure', facts({ repeat_failure_n: null })), 'HOLD');
  assert.equal(verdictOf('repeat_failure', facts({ prior_tool_failures: 2, repeat_failure_n: 3 })), 'PASS');
});

test('amount_limit: over limit → BLOCK; null fact → HOLD; within limit → PASS', () => {
  assert.equal(verdictOf('amount_limit', facts({ amount_usd: 48_000, approval_limit_usd: 25_000 })), 'BLOCK');
  assert.equal(verdictOf('amount_limit', facts({ amount_usd: null })), 'HOLD');
  assert.equal(verdictOf('amount_limit', facts({ approval_limit_usd: null })), 'HOLD');
  assert.equal(verdictOf('amount_limit', facts({ amount_usd: 8420, approval_limit_usd: 25000 })), 'PASS');
});

test('domain_allowlist: not allowlisted → BLOCK; null fact → HOLD; allowlisted → PASS', () => {
  assert.equal(verdictOf('domain_allowlist', facts({ dest_domain: 'northwind-remit.example', domain_allowed: false })), 'BLOCK');
  assert.equal(verdictOf('domain_allowlist', facts({ dest_domain: 'northwind-remit.example', domain_allowed: null })), 'HOLD');
  assert.equal(verdictOf('domain_allowlist', facts({ dest_domain: 'bank.northwind.example', domain_allowed: true })), 'PASS');
});

test('approval_evidence: payment without approval → HOLD; null fact → HOLD; approved → PASS', () => {
  assert.equal(verdictOf('approval_evidence', facts({ approval_status: 'missing' })), 'HOLD');
  assert.equal(verdictOf('approval_evidence', facts({ approval_status: null })), 'HOLD');
  assert.equal(verdictOf('approval_evidence', facts({ approval_status: 'approved' })), 'PASS');
});

test('a non-action boundary (no candidate action) yields PASS for the action rules', () => {
  const r = evaluateRules(snap(facts({ tool_known: null, tool_impact: null, amount_usd: null, dest_domain: null, domain_allowed: null, approval_status: null })));
  for (const rule of r) assert.equal(rule.verdict, 'PASS', `${rule.rule_id} should PASS with no candidate action`);
});

test('S3 over-limit payment → amount_limit BLOCK and worstVerdict BLOCK', () => {
  const r = evaluateRules(snap(facts({ amount_usd: 48_000, approval_limit_usd: 25_000 })));
  assert.equal(worstVerdict(r), 'BLOCK');
  assert.equal(r.find(x => x.rule_id === 'amount_limit')!.verdict, 'BLOCK');
});

test('S4 missing approval → approval_evidence HOLD', () => {
  const r = evaluateRules(snap(facts({ approval_status: 'missing' })));
  assert.equal(worstVerdict(r), 'HOLD');
  assert.equal(r.find(x => x.rule_id === 'approval_evidence')!.verdict, 'HOLD');
});

test('S6 non-allowlisted domain → domain_allowlist BLOCK', () => {
  const r = evaluateRules(snap(facts({ tool_impact: 'write', amount_usd: null, dest_domain: 'northwind-remit.example', domain_allowed: false })));
  assert.equal(r.find(x => x.rule_id === 'domain_allowlist')!.verdict, 'BLOCK');
});

test('S1 normal payment → every rule PASS', () => {
  const r = evaluateRules(snap(facts()));
  assert.ok(r.every(x => x.verdict === 'PASS'));
  assert.equal(worstVerdict(r), 'PASS');
  assert.equal(r.length, RULE_IDS.length);
});

test('worstVerdict ordering: STOP > BLOCK > HOLD > ALERT > PASS', () => {
  const mk = (v: RuleVerdict) => ({ rule_id: 'x', verdict: v, reason: '', evidence_refs: [], authoritative_source: '' });
  assert.equal(worstVerdict([mk('PASS'), mk('ALERT'), mk('HOLD'), mk('BLOCK'), mk('STOP')]), 'STOP');
  assert.equal(worstVerdict([mk('HOLD'), mk('ALERT'), mk('PASS')]), 'HOLD');
  assert.equal(worstVerdict([]), 'PASS');
});
