// SOC-triage scenarios for the demo (logs/2026-09-30_DEMO_SOC_PLAN.md §2), mirroring sandbox/scenarios/soc.ts
// and the alert texts in sandbox/seed.ts. F0 stub: D1 fills SOC_SCENARIOS and makeSocBackground.
import { traceFor, root, lbl } from './trace.js';

export const SOC_AGENT = 'soc-agent';
const trace = traceFor(SOC_AGENT);
void trace; void root; void lbl;

export const SOC_SCENARIOS = Object.freeze([]);

/** Seeded benign triage runs. Background alert i is ALERT-(201+i) with ticket TCK-(301+i) (TENANT.soc_tickets). */
export function makeSocBackground(seed, n) { void seed; void n; return []; }
