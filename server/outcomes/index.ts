// T1 (deepseek) — independent read-back outcome verifier (docs/CONTRACTS.md §8.3, RFC §8).
// After an executed side-effect tool returns (HTTP 200), the ledger/mail sink — not the tool's
// response — decides the true outcome. This verifier polls with bounded backoff until a terminal
// state or the deadline. It appends to `outcomes` and the outbox and never touches events,
// snapshots, evaluations or decisions.
import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from '../storage/db.ts';
import * as repos from '../storage/repos.ts';
import type { AuthorityReader } from '../../sandbox/index.ts';

export interface OutcomeVerifierOptions { deadlineMs: Record<string, number>; backoffMs: number[] }
export interface TrackInput {
  tenantId: string; runId: string; eventId: string; tool: string; operationId: string;
  expected: Record<string, string | number | boolean | null>;
}
export interface OutcomeVerifier {
  /** Idempotent per (tenant, operation). Only for executed side-effect tools. */
  track(q: Queryable, t: TrackInput): Promise<void>;
  /** Processes checks whose next_check_at has passed; returns how many were processed. */
  tick(): Promise<number>;
}
export const OUTCOME_TOOLS = ['payments.execute', 'email.send'] as const;

type State = 'pending' | 'verified_success' | 'verified_failure' | 'mismatch' | 'unknown_after_deadline';

interface CheckRow {
  tenant_id: string; operation_id: string; run_id: string; event_id: string; tool: string;
  state: State; expected: unknown; attempts: number; next_check_at: unknown; deadline_at: unknown;
}

type Observation =
  | { kind: 'payment'; status: 'posted' | 'pending' | 'failed' | null; payee: string | null; amount_usd: number | null }
  | { kind: 'email'; delivered: boolean; to: string | null };

const toMs = (v: unknown): number => (v instanceof Date ? v.getTime() : Date.parse(String(v)));
const isoMs = (ms: number): string => new Date(ms).toISOString();
const domainOf = (addr: string): string => (addr.includes('@') ? addr.split('@').pop()!.toLowerCase() : addr);

export function createOutcomeVerifier(db: Db, authority: AuthorityReader, opts: OutcomeVerifierOptions): OutcomeVerifier {
  const deadlineFor = (tool: string): number => opts.deadlineMs[tool] ?? 10_000;
  const backoffAt = (attempts: number): number => opts.backoffMs[Math.min(attempts, opts.backoffMs.length - 1)] ?? 2_000;

  async function observe(tool: string, tenantId: string, operationId: string): Promise<Observation> {
    if (tool === 'payments.execute') {
      const l = await authority.ledgerByOperation(tenantId, operationId);
      if (!l) return { kind: 'payment', status: null, payee: null, amount_usd: null };
      return { kind: 'payment', status: l.status, payee: l.payee, amount_usd: l.amount_usd };
    }
    const m = await authority.mailByOperation(tenantId, operationId);
    return m ? { kind: 'email', delivered: true, to: m.to } : { kind: 'email', delivered: false, to: null };
  }

  interface Verdict { state: State; checked: Record<string, string | number | boolean | null>; source: string; terminal: boolean }

  function decide(row: CheckRow, o: Observation, now: number): Verdict {
    const expected = (row.expected ?? {}) as Record<string, unknown>;
    if (o.kind === 'payment') {
      const src = 'sandbox.ledger';
      if (o.status === 'posted') {
        const payeeOk = String(expected.payee ?? '') === String(o.payee ?? '');
        const amountOk = Number(expected.amount_usd) === Number(o.amount_usd);
        return { state: payeeOk && amountOk ? 'verified_success' : 'mismatch', source: src, terminal: true,
          checked: { status: 'posted', payee: o.payee ?? '', amount_usd: Number(o.amount_usd ?? 0) } };
      }
      if (o.status === 'failed') {
        return { state: 'verified_failure', source: src, terminal: true,
          checked: { status: 'failed', payee: o.payee ?? '', amount_usd: Number(o.amount_usd ?? 0) } };
      }
      if (now >= toMs(row.deadline_at)) {
        return { state: 'unknown_after_deadline', source: src, terminal: true,
          checked: { status: o.status ?? 'not_observed', payee: o.payee ?? '', amount_usd: Number(o.amount_usd ?? 0) } };
      }
      return { state: 'pending', source: src, terminal: false,
        checked: { status: o.status ?? 'not_observed', payee: o.payee ?? '', amount_usd: Number(o.amount_usd ?? 0) } };
    }
    const src = 'sandbox.mail_sink';
    if (o.delivered) {
      const expectedDomain = String(expected.to_domain ?? '').toLowerCase();
      const got = domainOf(String(o.to ?? ''));
      return { state: expectedDomain !== '' && got === expectedDomain ? 'verified_success' : 'mismatch', source: src, terminal: true,
        checked: { delivered: true, to: o.to ?? '' } };
    }
    if (now >= toMs(row.deadline_at)) return { state: 'unknown_after_deadline', source: src, terminal: true, checked: { delivered: false } };
    return { state: 'pending', source: src, terminal: false, checked: { delivered: false } };
  }

  async function track(q: Queryable, t: TrackInput): Promise<void> {
    if (!(OUTCOME_TOOLS as readonly string[]).includes(t.tool)) return;
    const ins = await q.query(
      `INSERT INTO outcome_checks (tenant_id, operation_id, run_id, event_id, tool, state, expected, attempts, next_check_at, deadline_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, 0, $7, $8)
       ON CONFLICT (tenant_id, operation_id) DO NOTHING RETURNING operation_id`,
      [t.tenantId, t.operationId, t.runId, t.eventId, t.tool, JSON.stringify(t.expected), isoMs(Date.now() + backoffAt(0)), isoMs(Date.now() + deadlineFor(t.tool))],
    );
    if (ins.rows.length === 0) return; // already tracked: the initial observation was recorded before
    // The first track is itself the "start → pending" transition: record it in the append-only
    // history and the outbox, exactly like the terminal transitions.
    const source = t.tool === 'payments.execute' ? 'sandbox.ledger' : 'sandbox.mail_sink';
    const outcomeId = `out-${randomUUID()}`;
    await q.query(`INSERT INTO outcomes (tenant_id, outcome_id, operation_id, state, body) VALUES ($1, $2, $3, 'pending', $4)`,
      [t.tenantId, outcomeId, t.operationId, JSON.stringify({
        outcome_id: outcomeId, tenant_id: t.tenantId, operation_id: t.operationId, state: 'pending',
        checked: {}, source, observed_at: new Date().toISOString(),
      })]);
    await repos.appendOutbox(q, { tenant_id: t.tenantId, kind: 'outcome', ref_id: outcomeId, run_id: t.runId,
      payload: { operation_id: t.operationId, run_id: t.runId, event_id: t.eventId, state: 'pending', checked: {}, source } });
  }

  async function tick(): Promise<number> {
    let processed = 0;
    for (;;) {
      // Peek (read-only, no lock) so the authoritative read-back can run on the outer connection —
      // PGlite is single-connection, so a read inside db.tx() would deadlock against the open transaction.
      const peek = await db.query<CheckRow>(
        `SELECT tenant_id, operation_id, run_id, event_id, tool, state, expected, attempts, next_check_at, deadline_at
         FROM outcome_checks WHERE state = 'pending' AND next_check_at <= now()
         ORDER BY next_check_at ASC LIMIT 1`);
      const c = peek.rows[0];
      if (!c) break;
      const now = Date.now();
      const o = await observe(c.tool, c.tenant_id, c.operation_id);
      const v = decide(c, o, now);
      const attempts = c.attempts + 1;
      const advanced = await db.tx(async q => {
        // Re-lock and re-check inside the tx so a concurrent tick cannot double-transition.
        const cur = await q.query<{ state: State }>(
          `SELECT state FROM outcome_checks WHERE tenant_id = $1 AND operation_id = $2 FOR UPDATE`,
          [c.tenant_id, c.operation_id]);
        if (!cur.rows[0] || cur.rows[0].state !== 'pending') return false;
        if (v.terminal) {
          const outcomeId = `out-${randomUUID()}`;
          await q.query(`UPDATE outcome_checks SET state = $3, attempts = $4, updated_at = now() WHERE tenant_id = $1 AND operation_id = $2`,
            [c.tenant_id, c.operation_id, v.state, attempts]);
          await q.query(`INSERT INTO outcomes (tenant_id, outcome_id, operation_id, state, body) VALUES ($1, $2, $3, $4, $5)`,
            [c.tenant_id, outcomeId, c.operation_id, v.state, JSON.stringify({
              outcome_id: outcomeId, tenant_id: c.tenant_id, operation_id: c.operation_id, state: v.state,
              checked: v.checked, source: v.source, observed_at: new Date(now).toISOString(),
            })]);
          await repos.appendOutbox(q, { tenant_id: c.tenant_id, kind: 'outcome', ref_id: outcomeId, run_id: c.run_id,
            payload: { operation_id: c.operation_id, run_id: c.run_id, event_id: c.event_id, state: v.state, checked: v.checked, source: v.source } });
        } else {
          await q.query(`UPDATE outcome_checks SET attempts = $3, next_check_at = $4, updated_at = now() WHERE tenant_id = $1 AND operation_id = $2`,
            [c.tenant_id, c.operation_id, attempts, isoMs(now + backoffAt(attempts))]);
        }
        return true;
      });
      if (!advanced) continue;   // transitioned elsewhere between peek and lock; it is no longer pending
      processed++;
    }
    return processed;
  }

  return { track, tick };
}
