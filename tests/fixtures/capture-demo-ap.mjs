// Captures tests/fixtures/demo-ap-envelopes.json: node tests/fixtures/capture-demo-ap.mjs "$PWD". Run once on main before the SOC change.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const root = process.argv[2];
const { buildStream, ALL_SCENARIOS, TENANT } = await import(`${root}/web/demo/js/engine/scenarios.js`);
const { runStream } = await import(`${root}/web/demo/js/engine/router.js`);
const { DEFAULT_POLICY } = await import(`${root}/web/demo/js/engine/types.js`);
const tuple = e => [e.span_id, e.decision, e.action, e.decided_by, e.reasons.join('|'), e.rule_hits.map(h => h.id).join(',')].join('\t');
const lines = seed => {
  const ctx = { tenant: TENANT, policy: DEFAULT_POLICY, seed };
  const out = runStream(buildStream(seed), ctx).map(tuple);
  for (const t of ALL_SCENARIOS) for (const f of [null, 'timeout']) out.push(...runStream(t.spans, { ...ctx, faults: f ? { jev: f } : null }).map(e => `${f ?? '-'}\t${tuple(e)}`));
  return out;
};
const fx = { note: 'AP demo envelopes captured from main e7ea2ae before the SOC change (logs/2026-09-30_DEMO_SOC_PLAN.md §2). Tuple: span_id, decision, action, decided_by, reasons, rule ids.', seed7: lines(7), sha256: {} };
for (let s = 1; s <= 50; s++) fx.sha256[s] = createHash('sha256').update(lines(s).join('\n')).digest('hex');
writeFileSync(`${root}/tests/fixtures/demo-ap-envelopes.json`, JSON.stringify(fx, null, 1));
console.log(fx.seed7.length, 'lines for seed 7');
