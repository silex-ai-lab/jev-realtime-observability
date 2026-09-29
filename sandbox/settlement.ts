// Settlement: how a ledger row settles over time (docs/CONTRACTS.md §8.1). payments.execute stores
// the settlement hint; the effective status is computed at read time by every reader
// (AuthorityReader.ledgerByOperation, erp.payment_status, the outcome verifier), so a tool returning
// HTTP 200 does not by itself mean "posted" — the point of S5/S9.
export type EffectiveLedgerStatus = 'posted' | 'pending' | 'failed';
export type SettlementKind = 'immediate' | 'pending_forever' | 'pending_then_posted' | 'fail_after';

export interface ParsedSettlement { kind: SettlementKind; ms: number | null }

/** Parses a settlement hint: 'immediate' (default), 'pending_forever', 'pending_then_posted:<ms>', 'fail_after:<ms>'. */
export function parseSettlement(settlement: string | null | undefined): ParsedSettlement {
  const s = (settlement ?? '').trim();
  if (s === '' || s === 'immediate') return { kind: 'immediate', ms: null };
  if (s === 'pending_forever') return { kind: 'pending_forever', ms: null };
  const m = /^(pending_then_posted|fail_after):(\d+)$/.exec(s);
  if (m) return { kind: m[1] as 'pending_then_posted' | 'fail_after', ms: Number(m[2]) };
  return { kind: 'immediate', ms: null };
}

/** Effective status at read time. Unknown hints degrade to 'immediate' (posted), never to a blocking state. */
export function effectiveLedgerStatus(settlement: string | null | undefined, createdAtMs: number, nowMs: number): EffectiveLedgerStatus {
  const { kind, ms } = parseSettlement(settlement);
  switch (kind) {
    case 'immediate': return 'posted';
    case 'pending_forever': return 'pending';
    case 'pending_then_posted': return (ms != null && nowMs - createdAtMs >= ms) ? 'posted' : 'pending';
    case 'fail_after': return (ms != null && nowMs - createdAtMs >= ms) ? 'failed' : 'pending';
  }
}
