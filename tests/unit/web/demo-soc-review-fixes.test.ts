// Code review r1 of logs/2026-09-30_DEMO_SOC_PLAN.md: the domain lookup ignores inherited keys, each agent is asked
// only its own questions, and the two SOC hold rules release when the approval exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error browser modules without declaration files
import { domainFrom } from '../../../web/demo/js/engine/domains.js';
// @ts-expect-error browser modules without declaration files
import { runStream } from '../../../web/demo/js/engine/router.js';
// @ts-expect-error browser modules without declaration files
import { TENANT, buildStream } from '../../../web/demo/js/engine/scenarios.js';
// @ts-expect-error browser modules without declaration files
import { SOC_SCENARIOS } from '../../../web/demo/js/engine/scenarios-soc.js';
// @ts-expect-error browser modules without declaration files
import { DEFAULT_POLICY } from '../../../web/demo/js/engine/types.js';

test('domainFrom: own keys only; inherited names, unknown and missing fall back to AP', () => {
  for (const q of ['?domain=__proto__', '?domain=constructor', '?domain=toString', '?domain=hasOwnProperty', '?domain=xx', '', '?domain=']) {
    const d = domainFrom(q);
    assert.equal(d.id, 'ap', q);
    assert.ok(Array.isArray(d.inject) && d.inject.length, q);
  }
  assert.equal(domainFrom('?seed=3&domain=soc').id, 'soc');
});

test('each agent is asked only its own questions', () => {
  const ctx = { tenant: TENANT, policy: DEFAULT_POLICY, seed: 7 };
  const ap = runStream(buildStream(7), ctx), soc = runStream(buildStream(7, { domain: 'soc' }), ctx);
  assert.ok(ap.length && soc.length);
  assert.ok(ap.every((e: any) => !('goal_deviation' in e.answers)), 'AP never asked goal_deviation');
  assert.ok(soc.every((e: any) => !('payee_mismatch' in e.answers)), 'SOC never asked payee_mismatch');
  assert.ok(soc.some((e: any) => 'goal_deviation' in e.answers));
});

const trace = (id: string) => SOC_SCENARIOS.find((t: any) => t.scenario === id).spans;
const toolEnv = (envs: any[], tool: string) => envs.find((e: any) => e.tool?.name === tool);

test('allowlist_change_approval releases when an approved change exists for the IP', () => {
  const tenant = { ...TENANT, soc_change_approvals: [...TENANT.soc_change_approvals, { id: 'CHG-TEST', ip: '203.0.113.7', action: 'allowlist', status: 'approved' }] };
  const held = toolEnv(runStream(trace('SOC2'), { tenant: TENANT, policy: DEFAULT_POLICY, seed: 1 }), 'firewall.allowlist_ip');
  const freed = toolEnv(runStream(trace('SOC2'), { tenant, policy: DEFAULT_POLICY, seed: 1 }), 'firewall.allowlist_ip');
  assert.equal(held.decision, 'HOLD');
  assert.ok(!freed.rule_hits.some((h: any) => h.id === 'allowlist_change_approval'));
  assert.notEqual(freed.decided_by, 'rule');
  // A pending (not approved) change does not release it.
  const pending = { ...TENANT, soc_change_approvals: [{ id: 'CHG-P', ip: '203.0.113.7', action: 'allowlist', status: 'pending' }] };
  assert.equal(toolEnv(runStream(trace('SOC2'), { tenant: pending, policy: DEFAULT_POLICY, seed: 1 }), 'firewall.allowlist_ip').decision, 'HOLD');
});

test('privileged_suspend_incident releases with an approved suspend incident, for privileged and break-glass users', () => {
  const withIncident = (users: any) => ({ ...TENANT, soc_users: users, soc_incidents: [...TENANT.soc_incidents, { id: 'INC-TEST', target_user: 'u-admin-02', action: 'suspend', status: 'approved' }] });
  const suspend = (tenant: any) => toolEnv(runStream(trace('SOC3'), { tenant, policy: DEFAULT_POLICY, seed: 1 }), 'identity.suspend_user');
  assert.equal(suspend(TENANT).decision, 'HOLD');
  const freed = suspend(withIncident(TENANT.soc_users));
  assert.ok(!freed.rule_hits.some((h: any) => h.id === 'privileged_suspend_incident'));
  const breakGlass = { ...TENANT.soc_users, 'u-admin-02': { ...TENANT.soc_users['u-admin-02'], privileged: false, break_glass: true } };
  assert.equal(suspend({ ...TENANT, soc_users: breakGlass }).decision, 'HOLD', 'break-glass without an incident is held');
  assert.ok(!suspend(withIncident(breakGlass)).rule_hits.some((h: any) => h.id === 'privileged_suspend_incident'), 'break-glass with an incident is released');
});
