// The two SOC rules (docs/CONTRACTS.md §11.5), every branch: not applicable → PASS; missing fact → HOLD;
// unapproved → HOLD; approved (or not privileged) → PASS. AP actions (no soc_tool fact) always PASS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRules } from '../../../server/rules/index.ts';
import type { DecisionSnapshot } from '../../../contracts/snapshot.ts';

const snap = (facts: Record<string, unknown>): DecisionSnapshot => ({
  snapshot_id: 'snap-1', tenant_id: 't-alpha', run_id: 'run-1', event_id: 'ev-1', boundary: 'pre_tool',
  as_of: new Date().toISOString(), cutoff_seq: 1, extractor_version: 'test', task_goal: null,
  candidate_action: null, history: [], evidence: [],
  facts: { tool_known: true, tool_impact: 'write', prior_tool_failures: 0, repeat_failure_n: 3, snapshot_age_ms: 10, stale_after_ms: 5000, ...facts } as DecisionSnapshot['facts'],
  required_evidence: [], missing_evidence: [], stale_evidence: [], judge_view: { state: '', token_estimate: 0, truncated: false },
});
const verdict = (id: string, facts: Record<string, unknown>) => evaluateRules(snap(facts)).find(r => r.rule_id === id)!.verdict;

test('privileged_suspend_incident: every branch', () => {
  const s = { soc_tool: 'identity.suspend_user' };
  assert.equal(verdict('privileged_suspend_incident', {}), 'PASS', 'AP action: not applicable');
  assert.equal(verdict('privileged_suspend_incident', { soc_tool: 'firewall.block_ip' }), 'PASS', 'other SOC tool');
  assert.equal(verdict('privileged_suspend_incident', { ...s, target_privileged: null }), 'HOLD', 'missing fact');
  assert.equal(verdict('privileged_suspend_incident', { ...s, target_privileged: false, incident_approved_for_target_action: false }), 'PASS', 'not privileged');
  assert.equal(verdict('privileged_suspend_incident', { ...s, target_privileged: true, incident_approved_for_target_action: null }), 'HOLD', 'missing incident fact');
  assert.equal(verdict('privileged_suspend_incident', { ...s, target_privileged: true, incident_approved_for_target_action: false }), 'HOLD', 'no approved incident');
  assert.equal(verdict('privileged_suspend_incident', { ...s, target_privileged: true, incident_approved_for_target_action: true }), 'PASS', 'approved incident');
});

test('allowlist_change_approval: every branch', () => {
  const s = { soc_tool: 'firewall.allowlist_ip' };
  assert.equal(verdict('allowlist_change_approval', {}), 'PASS', 'AP action: not applicable');
  assert.equal(verdict('allowlist_change_approval', { soc_tool: 'firewall.block_ip' }), 'PASS', 'blocking needs no change approval');
  assert.equal(verdict('allowlist_change_approval', { ...s, change_approved_for_ip: null }), 'HOLD', 'missing fact');
  assert.equal(verdict('allowlist_change_approval', { ...s, change_approved_for_ip: false }), 'HOLD', 'no approved change');
  assert.equal(verdict('allowlist_change_approval', { ...s, change_approved_for_ip: true }), 'PASS', 'approved change');
});

test('the test-only disabled list reports the rule as PASS with a reason saying so, and nothing else changes', () => {
  const f = { soc_tool: 'firewall.allowlist_ip', change_approved_for_ip: false };
  const r = evaluateRules(snap(f), ['allowlist_change_approval']);
  const al = r.find(x => x.rule_id === 'allowlist_change_approval')!;
  assert.deepEqual([al.verdict, al.reason], ['PASS', 'rule disabled (test-only seam)']);
  assert.deepEqual(r.filter(x => x.rule_id !== 'allowlist_change_approval'), evaluateRules(snap(f)).filter(x => x.rule_id !== 'allowlist_change_approval'));
});
