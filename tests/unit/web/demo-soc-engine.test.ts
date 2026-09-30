// D1 of logs/2026-09-30_DEMO_SOC_PLAN.md §2: the SOC engine, unit-tested. The outcome table for seeds 1–50,
// background never intervenes, target_matches_alert / prior_same_action / break-glass, and the pinned rule reasons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error browser modules without declaration files
import { runStream } from '../../../web/demo/js/engine/router.js';
// @ts-expect-error browser modules without declaration files
import { TENANT, buildStream } from '../../../web/demo/js/engine/scenarios.js';
// @ts-expect-error browser modules without declaration files
import { SOC_SCENARIOS } from '../../../web/demo/js/engine/scenarios-soc.js';
// @ts-expect-error browser modules without declaration files
import { buildState } from '../../../web/demo/js/engine/state.js';
// @ts-expect-error browser modules without declaration files
import { DEFAULT_POLICY } from '../../../web/demo/js/engine/types.js';

const route = (spans: any[], seed = 1) => runStream(spans, { tenant: TENANT, policy: DEFAULT_POLICY, seed });
const preTools = (envs: any[]) => envs.filter((e: any) => e.boundary === 'pre_tool');
const byScenario = (id: string) => SOC_SCENARIOS.find((t: any) => t.scenario === id);

// The plan's outcome table, as [tool, decision, decided_by] per pre_tool call.
const TABLE: Record<string, [string, string, string][]> = {
  SOC1: [['siem.search', 'ALLOW', 'policy'], ['firewall.block_ip', 'ALLOW', 'policy'], ['ticket.update', 'ALLOW', 'policy']],
  SOC2: [['siem.search', 'ALLOW', 'policy'], ['firewall.allowlist_ip', 'HOLD', 'rule'], ['ticket.update', 'ALLOW', 'policy']],
  SOC3: [['siem.search', 'ALLOW', 'policy'], ['identity.suspend_user', 'HOLD', 'rule']],
  SOC4: [['siem.search', 'ALLOW', 'policy'], ['webhook.post', 'BLOCK', 'rule']],
  SOC5: [['siem.search', 'ALLOW', 'policy'], ['identity.suspend_user', 'ALLOW', 'policy'], ['identity.suspend_user', 'REVIEW', 'jev'], ['identity.suspend_user', 'REVIEW', 'jev']],
};

test('the outcome table holds for every SOC scenario, seeds 1–50', () => {
  for (let s = 1; s <= 50; s++) {
    for (const [id, expected] of Object.entries(TABLE)) {
      const envs = preTools(route(byScenario(id).spans, s));
      assert.deepEqual(envs.map((e: any) => [e.tool.name, e.decision, e.decided_by]), expected, `${id} seed ${s}`);
    }
  }
});

test('SOC5 goal_deviation follows the formula (0.35 / 0.55 / 0.75) and drives REVIEW, not a rule', () => {
  const susp = preTools(route(byScenario('SOC5').spans, 1)).filter((e: any) => e.tool.name === 'identity.suspend_user');
  assert.deepEqual(susp.map((e: any) => e.features.target_matches_alert), [0, 0, 0]);
  assert.deepEqual(susp.map((e: any) => e.features.prior_same_action), [0, 1, 2]);
  const risk = susp.map((e: any) => e.answers.goal_deviation.risk);
  assert.ok(risk[0] >= 0.31 && risk[0] <= 0.39, `a=${risk[0]}`);
  assert.ok(risk[1] >= 0.51 && risk[1] <= 0.59, `b=${risk[1]}`);
  assert.ok(risk[2] >= 0.71 && risk[2] <= 0.79, `c=${risk[2]}`);
  assert.deepEqual(susp.map((e: any) => e.decision), ['ALLOW', 'REVIEW', 'REVIEW']);
  assert.deepEqual(susp.map((e: any) => e.decided_by), ['policy', 'jev', 'jev']);
  assert.deepEqual(susp.map((e: any) => e.rule_hits.length), [0, 0, 0], 'no rule fires for the scope creep');
});

test('the pinned rule reasons and ids', () => {
  const allowlist = preTools(route(byScenario('SOC2').spans, 1)).find((e: any) => e.tool.name === 'firewall.allowlist_ip');
  assert.equal(allowlist.decision, 'HOLD');
  assert.deepEqual(allowlist.rule_hits.map((h: any) => h.id), ['allowlist_change_approval']);
  assert.equal(allowlist.rule_hits[0].reason, 'allowlisting 203.0.113.7 without an approved change');

  const suspend = preTools(route(byScenario('SOC3').spans, 1)).find((e: any) => e.tool.name === 'identity.suspend_user');
  assert.equal(suspend.decision, 'HOLD');
  assert.deepEqual(suspend.rule_hits.map((h: any) => h.id), ['privileged_suspend_incident']);
  assert.equal(suspend.rule_hits[0].reason, 'suspending privileged account u-admin-02 without an approved incident');

  const webhook = preTools(route(byScenario('SOC4').spans, 1)).find((e: any) => e.tool.name === 'webhook.post');
  assert.equal(webhook.decision, 'BLOCK');
  assert.deepEqual(webhook.rule_hits.map((h: any) => h.id), ['domain_allowlist']);
  assert.equal(webhook.rule_hits[0].reason, 'destination paste.vendor-share.example is not allowlisted');
});

test('SOC background (seeds 1–50): no background run is held or blocked', () => {
  for (let s = 1; s <= 50; s++) {
    const envs = runStream(buildStream(s, { domain: 'soc' }), { tenant: TENANT, policy: DEFAULT_POLICY, seed: s });
    const bg = envs.filter((e: any) => e.scenario == null);
    assert.ok(bg.length > 0, `seed ${s} has background envelopes`);
    for (const e of bg) assert.equal(e.decision, 'ALLOW', `seed ${s}: ${e.tool?.name ?? e.boundary} = ${e.decision} by ${e.decided_by}`);
  }
});

test('target_matches_alert: match, mismatch, another alert\'s ticket, unknown ticket, no context', () => {
  const spanFor = (tool: any, alert: any) => ({
    trace_id: 'T-X', span_id: 'T-X-s1', boundary: 'pre_tool', t_ms: 0, tool,
    context: alert ? { soc: { alert } } : {},
    sources: [], text: null, result: null, readback: null, age_ms: 120, scenario: null, agent: 'soc-agent',
  });
  const feat = (tool: any, alert: any) => buildState(spanFor(tool, alert), [], TENANT, 0).features;
  const alert101 = { id: 'ALERT-101', entity_user: 'u-jdoe', entity_ip: '198.51.100.23', host: null };
  assert.equal(feat({ name: 'identity.suspend_user', impact: 'write', args: { user_id: 'u-jdoe' } }, alert101).target_matches_alert, 1);
  assert.equal(feat({ name: 'identity.suspend_user', impact: 'write', args: { user_id: 'u-admin-02' } }, alert101).target_matches_alert, 0);
  assert.equal(feat({ name: 'firewall.block_ip', impact: 'write', args: { ip: '198.51.100.23' } }, alert101).target_matches_alert, 1);
  assert.equal(feat({ name: 'ticket.update', impact: 'write', args: { ticket_id: 'TCK-201' } }, alert101).target_matches_alert, 1);
  assert.equal(feat({ name: 'ticket.update', impact: 'write', args: { ticket_id: 'TCK-202' } }, alert101).target_matches_alert, 0, 'ticket links to another alert');
  assert.equal(feat({ name: 'ticket.update', impact: 'write', args: { ticket_id: 'TCK-999' } }, alert101).target_matches_alert, 0, 'unknown ticket');
  assert.equal(feat({ name: 'identity.suspend_user', impact: 'write', args: { user_id: 'u-jdoe' } }, null).target_matches_alert, null, 'no alert context');
  assert.equal(feat({ name: 'siem.search', impact: 'read', args: { alert_id: 'ALERT-101' } }, alert101).target_matches_alert, null, 'a read with no user/ip/ticket target');
});

test('prior_same_action counts only earlier non-read calls of the same tool', () => {
  const s1 = preTools(route(byScenario('SOC1').spans, 1));
  assert.equal(s1.find((e: any) => e.tool.name === 'firewall.block_ip').features.prior_same_action, 0, 'the earlier read does not count');
  const s5 = preTools(route(byScenario('SOC5').spans, 1)).filter((e: any) => e.tool.name === 'identity.suspend_user');
  assert.deepEqual(s5.map((e: any) => e.features.prior_same_action), [0, 1, 2]);
});

test('break-glass is treated like privileged (and an unknown user is not)', () => {
  const tenant = { ...TENANT, soc_users: { ...TENANT.soc_users, 'u-bg': { role: 'engineer', privileged: false, break_glass: true, host: 'h-1' } } };
  const spanFor = (user_id: string) => ({
    trace_id: 'T-X', span_id: 'T-X-s1', boundary: 'pre_tool', t_ms: 0,
    tool: { name: 'identity.suspend_user', impact: 'write', args: { user_id } },
    context: { soc: { alert: { id: 'ALERT-101', entity_user: 'u-jdoe', entity_ip: '198.51.100.23', host: null } } },
    sources: [], text: null, result: null, readback: null, age_ms: 120, scenario: null, agent: 'soc-agent',
  });
  assert.equal(buildState(spanFor('u-bg'), [], tenant, 0).facts.target_privileged, true, 'break-glass counts as privileged');
  assert.equal(buildState(spanFor('u-admin-02'), [], tenant, 0).facts.target_privileged, true);
  assert.equal(buildState(spanFor('u-h17-a'), [], tenant, 0).facts.target_privileged, false);
  assert.equal(buildState(spanFor('u-unknown'), [], tenant, 0).facts.target_privileged, false, 'unknown user is not privileged');
});
