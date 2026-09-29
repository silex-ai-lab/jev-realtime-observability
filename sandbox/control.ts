// T1 (deepseek) — Gate C sandbox control (docs/CONTRACTS.md §9.1–9.3, RFC §7.1 gate binding).
// authorityVersion hashes the authoritative facts a call depends on, so the gateway can detect that
// authority changed after a ControlDecision was issued (e.g. an approval revoked). createControlVerifier
// is the gateway's requireControl: it loads the ControlDecision from control_decisions by control_id —
// never trusting a caller-supplied body — and verifies it in the order §9.2 lists.
import type { Db, Queryable } from '../server/storage/db.ts';
import type { ControlDecision } from '../contracts/decision.ts';
import type { ToolCall } from './index.ts';
import { canonicalJson, digestOf, sha256 } from '../contracts/canonical.ts';

/** The write and payment tools a control gates (docs/CONTRACTS.md §9). Read tools are never gated. */
export const GATED_TOOLS = ['payments.execute', 'email.send'] as const;

const arr = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p.map(String) : []; } catch { return []; } }
  return [];
};

/**
 * sha256 over the authority facts this call depends on (docs/CONTRACTS.md §9.1). Recomputing it at
 * execution must yield the value the gate stamped into the control, or the call is not executed.
 */
export async function authorityVersion(db: Queryable, tenantId: string, call: Pick<ToolCall, 'tool' | 'args'>): Promise<string> {
  if (call.tool === 'payments.execute') {
    const invoiceId = call.args.invoice_id == null ? '' : String(call.args.invoice_id);
    const accountRef = call.args.account_ref == null ? '' : String(call.args.account_ref);
    const inv = await db.query<{ invoice_id: string; amount_usd: number; vendor_name: string }>(
      `SELECT invoice_id, amount_usd, vendor_name FROM sandbox.invoices WHERE tenant_id = $1 AND invoice_id = $2`, [tenantId, invoiceId]);
    const appr = await db.query<{ approval_id: string; status: string }>(
      `SELECT approval_id, status FROM sandbox.approvals WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY approval_id ASC LIMIT 1`, [tenantId, invoiceId]);
    const policy = await db.query<{ approval_limit_usd: number }>(
      `SELECT approval_limit_usd FROM sandbox.tenant_policies WHERE tenant_id = $1`, [tenantId]);
    const acct = await db.query<{ holder_name: string }>(
      `SELECT holder_name FROM sandbox.accounts WHERE tenant_id = $1 AND account_ref = $2`, [tenantId, accountRef]);
    const links = accountRef === '' ? { rows: [] as { vendor_id: string }[] }
      : await db.query<{ vendor_id: string }>(`SELECT vendor_id FROM sandbox.account_vendors WHERE tenant_id = $1 AND account_ref = $2 ORDER BY vendor_id ASC`, [tenantId, accountRef]);
    return sha256(canonicalJson({
      kind: 'payment',
      invoice: inv.rows[0] ? { invoice_id: inv.rows[0].invoice_id, amount_usd: inv.rows[0].amount_usd, vendor_name: inv.rows[0].vendor_name } : null,
      approval: appr.rows[0] ? { approval_id: appr.rows[0].approval_id, status: appr.rows[0].status } : null,
      tenant_limit: policy.rows[0]?.approval_limit_usd ?? null,
      account: acct.rows[0] ? { holder_name: acct.rows[0].holder_name, linked_vendor_ids: links.rows.map(l => l.vendor_id) } : null,
    }));
  }
  if (call.tool === 'email.send') {
    const policy = await db.query<{ domain_allowlist: unknown }>(
      `SELECT domain_allowlist FROM sandbox.tenant_policies WHERE tenant_id = $1`, [tenantId]);
    return sha256(canonicalJson({ kind: 'email', domain_allowlist: arr(policy.rows[0]?.domain_allowlist) }));
  }
  return sha256(canonicalJson({ kind: call.tool }));
}

/** Sets an approval to 'rejected' — a sandbox helper for tests and demos (docs/CONTRACTS.md §9.1). */
export async function revokeApproval(db: Queryable, tenantId: string, approvalId: string): Promise<void> {
  await db.query(`UPDATE sandbox.approvals SET status = 'rejected' WHERE tenant_id = $1 AND approval_id = $2`, [tenantId, approvalId]);
}

/**
 * The gateway's requireControl (docs/CONTRACTS.md §9.2): loads the ControlDecision from
 * control_decisions by control_id (never trusts a caller-supplied body) and verifies §9.2's checks
 * in order. It performs no side effect and does not consume the nonce — the gateway consumes it
 * atomically with the side effect.
 */
export function createControlVerifier(db: Db): (call: ToolCall, control: ControlDecision | null) => Promise<{ ok: boolean; reason: string }> {
  return async (call, control) => {
    if (!control) return { ok: false, reason: 'no ControlDecision bound to this call' };
    const row = await db.query<{ body: unknown; revoked_at: unknown; consumed_at: unknown }>(
      `SELECT body, revoked_at, consumed_at FROM control_decisions WHERE control_id = $1`, [control.control_id]);
    const stored = row.rows[0];
    if (!stored) return { ok: false, reason: 'control not found' };
    const c = stored.body as ControlDecision;
    // 1. binding: exists (done) and tenant / run / tool / operation match the call.
    if (c.tenant_id !== call.tenantId) return { ok: false, reason: 'control tenant mismatch' };
    if (c.run_id !== call.runId) return { ok: false, reason: 'control run mismatch' };
    if (c.tool !== call.tool) return { ok: false, reason: 'control tool mismatch' };
    if (c.operation_id !== call.operationId) return { ok: false, reason: 'control operation mismatch' };
    // 2. args digest (no check-A-execute-B).
    if (c.args_digest !== digestOf(call.args)) return { ok: false, reason: 'control args digest mismatch' };
    // 3. action allow.
    if (c.action !== 'allow') return { ok: false, reason: `control action ${c.action} does not allow execution` };
    // 4. not expired.
    if (Date.parse(c.expires_at) <= Date.now()) return { ok: false, reason: 'control expired' };
    // 5. not revoked.
    if (stored.revoked_at != null) return { ok: false, reason: 'control revoked' };
    // 6. not consumed.
    if (stored.consumed_at != null) return { ok: false, reason: 'control already consumed' };
    // 7. authority unchanged.
    const now = await authorityVersion(db, call.tenantId, { tool: call.tool, args: call.args });
    if (c.authorization_version !== now) return { ok: false, reason: 'authorization changed after the control was issued' };
    return { ok: true, reason: 'ok' };
  };
}
