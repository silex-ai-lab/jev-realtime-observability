// F0 of logs/2026-09-29_SUMO_DEMO_PLAN.md: one gated-tool set across domains. The AP constants stay
// byte-identical (control.test.ts pins GATED_TOOLS); every SOC write tool is gated; read tools never are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_GATED_TOOLS, GATED_TOOLS, SOC_GATED_TOOLS, isGatedTool } from '../../../sandbox/control.ts';
import { OUTCOME_TOOLS } from '../../../server/outcomes/index.ts';
import manifest from '../../../rubrics/rubric-manifest.v1.json' with { type: 'json' };

test('the gated set is exactly the AP list plus the SOC list, and OUTCOME_TOOLS stays AP-only', () => {
  assert.deepEqual([...GATED_TOOLS], ['payments.execute', 'email.send']);
  assert.deepEqual([...ALL_GATED_TOOLS], [...GATED_TOOLS, ...SOC_GATED_TOOLS]);
  assert.deepEqual([...OUTCOME_TOOLS], ['payments.execute', 'email.send']);
  for (const t of ALL_GATED_TOOLS) assert.equal(isGatedTool(t), true, t);
  for (const t of ['siem.search', 'erp.get_po', 'vendor.lookup', 'erp.payment_status', 'not.a.tool']) assert.equal(isGatedTool(t), false, t);
});

test('every SOC write tool in the registry is gated, and the registry knows every SOC gated tool', () => {
  const reg = (manifest as { tool_registry: Record<string, { impact: string }> }).tool_registry;
  for (const t of SOC_GATED_TOOLS) assert.ok(reg[t] && reg[t].impact !== 'read', `${t} must be a registered write tool`);
  const socWrites = Object.entries(reg).filter(([t, v]) => v.impact !== 'read' && !(GATED_TOOLS as readonly string[]).includes(t)).map(([t]) => t);
  assert.deepEqual(socWrites.sort(), [...SOC_GATED_TOOLS].sort());
  assert.equal(reg['siem.search'].impact, 'read');
});
