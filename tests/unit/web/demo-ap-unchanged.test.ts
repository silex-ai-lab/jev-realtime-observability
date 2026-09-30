// logs/2026-09-30_DEMO_SOC_PLAN.md §2: the SOC additions leave every AP span's behaviour fields unchanged
// (decision, action, decided_by, reasons, alert, rule ids) against the fixture captured from main before the change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
// @ts-expect-error browser modules without declaration files
import { buildStream, ALL_SCENARIOS, TENANT } from '../../../web/demo/js/engine/scenarios.js';
// @ts-expect-error browser modules without declaration files
import { runStream } from '../../../web/demo/js/engine/router.js';
// @ts-expect-error browser modules without declaration files
import { DEFAULT_POLICY } from '../../../web/demo/js/engine/types.js';

const fx = JSON.parse(readFileSync(new URL('../../fixtures/demo-ap-envelopes.json', import.meta.url), 'utf8'));
const tuple = (e: any) => [e.span_id, e.decision, e.action, e.decided_by, e.reasons.join('|'), String(e.alert), e.rule_hits.map((h: any) => h.id).join(',')].join('\t');
function lines(seed: number): string[] {
  const ctx = { tenant: TENANT, policy: DEFAULT_POLICY, seed };
  const out = runStream(buildStream(seed), ctx).map(tuple);
  for (const t of ALL_SCENARIOS) for (const f of [null, 'timeout']) out.push(...runStream(t.spans, { ...ctx, faults: f ? { jev: f } : null }).map((e: any) => `${f ?? '-'}\t${tuple(e)}`));
  return out;
}

test('seed 7: every AP line equals the fixture', () => assert.deepEqual(lines(7), fx.seed7));
test('seeds 1–50: AP behaviour hashes equal the fixture', () => {
  for (let s = 1; s <= 50; s++) assert.equal(createHash('sha256').update(lines(s).join('\n')).digest('hex'), fx.sha256[s], `seed ${s}`);
});
