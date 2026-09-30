// T1 (deepseek) — Gate C sandbox control (docs/CONTRACTS.md §9.1–9.3, RFC §7.1 gate binding).
// authorityVersion hashes the authoritative facts a call depends on, so the gateway can detect that
// authority changed after a ControlDecision was issued (e.g. an approval revoked). createControlVerifier
// is the cheap, lock-free pre-check; verifyControlInTx is the authoritative check that runs inside the
// same transaction as the nonce consumption and the side effect, with row locks, so a concurrent
// revokeApproval or control revoke either commits first (the call is refused) or waits until after the
// side effect commits — never interleaving with it.
import type { Db, Queryable } from '../server/storage/db.ts';
import type { ControlDecision } from '../contracts/decision.ts';
import type { ToolCall } from './index.ts';
import { canonicalJson, digestOf, sha256 } from '../contracts/canonical.ts';

/** The write and payment tools a control gates (docs/CONTRACTS.md §9). Read tools are never gated. */
export const GATED_TOOLS = ['payments.execute', 'email.send'] as const;
/** SOC domain (docs/CONTRACTS.md §11): every SOC write tool is gated. */
export const SOC_GATED_TOOLS = ['identity.suspend_user', 'firewall.block_ip', 'firewall.allowlist_ip', 'ticket.update', 'webhook.post'] as const;
/** Every gated tool across domains: the gateway, the driver and the gate metrics use this one set. */
export const ALL_GATED_TOOLS: readonly string[] = [...GATED_TOOLS, ...SOC_GATED_TOOLS];
export const isGatedTool = (tool: string): boolean => ALL_GATED_TOOLS.includes(tool);

const arr = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p.map(String) : []; } catch { return []; } }
  return [];
};

/**
 * sha256 over the authority facts this call depends on (docs/CONTRACTS.md §9.1). Recomputing it at
 * execution must yield the value the gate stamped into the control, or the call is not executed.
 * When `lock` is true, every authority row it reads is taken `FOR SHARE` so that a concurrent
 * `revokeApproval` / policy edit / account-link change serializes against this read.
 */
async function authorityVersionCore(db: Queryable, tenantId: string, call: Pick<ToolCall, 'tool' | 'args'>, lock: boolean): Promise<string> {
  const L = lock ? ' FOR SHARE' : '';
  if (call.tool === 'payments.execute') {
    const invoiceId = call.args.invoice_id == null ? '' : String(call.args.invoice_id);
    const accountRef = call.args.account_ref == null ? '' : String(call.args.account_ref);
    const inv = await db.query<{ invoice_id: string; amount_usd: number; vendor_name: string }>(
      `SELECT invoice_id, amount_usd, vendor_name FROM sandbox.invoices WHERE tenant_id = $1 AND invoice_id = $2${L}`, [tenantId, invoiceId]);
    const appr = await db.query<{ approval_id: string; status: string }>(
      `SELECT approval_id, status FROM sandbox.approvals WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY approval_id ASC LIMIT 1${L}`, [tenantId, invoiceId]);
    const policy = await db.query<{ approval_limit_usd: number }>(
      `SELECT approval_limit_usd FROM sandbox.tenant_policies WHERE tenant_id = $1${L}`, [tenantId]);
    const acct = await db.query<{ holder_name: string }>(
      `SELECT holder_name FROM sandbox.accounts WHERE tenant_id = $1 AND account_ref = $2${L}`, [tenantId, accountRef]);
    const links = accountRef === '' ? { rows: [] as { vendor_id: string }[] }
      : await db.query<{ vendor_id: string }>(`SELECT vendor_id FROM sandbox.account_vendors WHERE tenant_id = $1 AND account_ref = $2 ORDER BY vendor_id ASC${L}`, [tenantId, accountRef]);
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
      `SELECT domain_allowlist FROM sandbox.tenant_policies WHERE tenant_id = $1${L}`, [tenantId]);
    return sha256(canonicalJson({ kind: 'email', domain_allowlist: arr(policy.rows[0]?.domain_allowlist) }));
  }
  // SOC domain (docs/CONTRACTS.md §11.5): the rows each SOC rule reads.
  if (call.tool === 'identity.suspend_user') {
    const userId = call.args.user_id == null ? '' : String(call.args.user_id);
    const user = await db.query<{ user_id: string; role: string; privileged: boolean; break_glass: boolean; status: string }>(
      `SELECT user_id, role, privileged, break_glass, status FROM sandbox.soc_users WHERE tenant_id = $1 AND user_id = $2${L}`, [tenantId, userId]);
    const inc = await db.query<{ incident_id: string; status: string }>(
      `SELECT incident_id, status FROM sandbox.soc_incidents WHERE tenant_id = $1 AND target_user = $2 AND action = 'suspend' ORDER BY incident_id ASC${L}`, [tenantId, userId]);
    return sha256(canonicalJson({ kind: 'soc_suspend', user: user.rows[0] ?? null, incidents: inc.rows }));
  }
  if (call.tool === 'firewall.block_ip' || call.tool === 'firewall.allowlist_ip') {
    const ip = call.args.ip == null ? '' : String(call.args.ip);
    const rules = await db.query<{ ip: string; list: string }>(
      `SELECT ip, list FROM sandbox.soc_firewall_rules WHERE tenant_id = $1 ORDER BY ip ASC, list ASC${L}`, [tenantId]);
    const ch = await db.query<{ change_id: string; status: string }>(
      `SELECT change_id, status FROM sandbox.soc_change_approvals WHERE tenant_id = $1 AND ip = $2 AND action = 'allowlist' ORDER BY change_id ASC${L}`, [tenantId, ip]);
    return sha256(canonicalJson({ kind: 'soc_firewall', ip, rules: rules.rows, changes: ch.rows }));
  }
  if (call.tool === 'ticket.update') {
    const ticketId = call.args.ticket_id == null ? '' : String(call.args.ticket_id);
    const t = await db.query<{ ticket_id: string; status: string }>(
      `SELECT ticket_id, status FROM sandbox.soc_tickets WHERE tenant_id = $1 AND ticket_id = $2${L}`, [tenantId, ticketId]);
    return sha256(canonicalJson({ kind: 'soc_ticket', ticket: t.rows[0] ?? null }));
  }
  if (call.tool === 'webhook.post') {
    const policy = await db.query<{ domain_allowlist: unknown }>(
      `SELECT domain_allowlist FROM sandbox.tenant_policies WHERE tenant_id = $1${L}`, [tenantId]);
    return sha256(canonicalJson({ kind: 'soc_webhook', domain_allowlist: arr(policy.rows[0]?.domain_allowlist) }));
  }
  return sha256(canonicalJson({ kind: call.tool }));
}

/** Lock-free authority version (preflight issue time and the cheap outside pre-check). */
export function authorityVersion(db: Queryable, tenantId: string, call: Pick<ToolCall, 'tool' | 'args'>): Promise<string> {
  return authorityVersionCore(db, tenantId, call, false);
}

/** Sets an approval to 'rejected' — a sandbox helper for tests and demos (docs/CONTRACTS.md §9.1). */
export async function revokeApproval(db: Queryable, tenantId: string, approvalId: string): Promise<void> {
  await db.query(`UPDATE sandbox.approvals SET status = 'rejected' WHERE tenant_id = $1 AND approval_id = $2`, [tenantId, approvalId]);
}

/** Checks 1–6 of §9.2 against an already-loaded control row (no I/O). */
function checkLoaded(call: ToolCall, c: ControlDecision, revokedAt: unknown, consumedAt: unknown): { ok: boolean; reason: string } {
  if (c.tenant_id !== call.tenantId) return { ok: false, reason: 'control tenant mismatch' };
  if (c.run_id !== call.runId) return { ok: false, reason: 'control run mismatch' };
  if (c.tool !== call.tool) return { ok: false, reason: 'control tool mismatch' };
  if (c.operation_id !== call.operationId) return { ok: false, reason: 'control operation mismatch' };
  if (c.args_digest !== digestOf(call.args)) return { ok: false, reason: 'control args digest mismatch' };
  if (c.action !== 'allow') return { ok: false, reason: `control action ${c.action} does not allow execution` };
  if (Date.parse(c.expires_at) <= Date.now()) return { ok: false, reason: 'control expired' };
  if (revokedAt != null) return { ok: false, reason: 'control revoked' };
  if (consumedAt != null) return { ok: false, reason: 'control already consumed' };
  return { ok: true, reason: 'ok' };
}

/**
 * The authoritative in-transaction check (docs/CONTRACTS.md §9.2). Called inside the gateway's
 * consume transaction: it takes the control row `FOR UPDATE`, re-checks every §9.2 condition, and
 * recomputes authorityVersion with `FOR SHARE` locks on the authority rows. A concurrent revocation
 * either committed before this (→ `not_executed`) or blocks until this transaction finishes.
 * It performs no side effect and does not consume the nonce — the gateway does that next, in the
 * same transaction.
 */
export async function verifyControlInTx(q: Queryable, call: ToolCall, control: ControlDecision | null): Promise<{ ok: boolean; reason: string }> {
  if (!control) return { ok: false, reason: 'no ControlDecision bound to this call' };
  const row = await q.query<{ body: unknown; revoked_at: unknown; consumed_at: unknown }>(
    `SELECT body, revoked_at, consumed_at FROM control_decisions WHERE control_id = $1 FOR UPDATE`, [control.control_id]);
  const stored = row.rows[0];
  if (!stored) return { ok: false, reason: 'control not found' };
  const c = stored.body as ControlDecision;
  const chk = checkLoaded(call, c, stored.revoked_at, stored.consumed_at);
  if (!chk.ok) return chk;
  const now = await authorityVersionCore(q, call.tenantId, { tool: call.tool, args: call.args }, true);
  if (c.authorization_version !== now) return { ok: false, reason: 'authorization changed after the control was issued' };
  return { ok: true, reason: 'ok' };
}

/**
 * The gateway's cheap, lock-free pre-check (docs/CONTRACTS.md §9.2): loads the ControlDecision from
 * control_decisions by control_id (never trusts a caller-supplied body) and verifies §9.2's checks.
 * It is advisory — the in-transaction check is the one that decides — and it performs no side effect
 * and does not consume the nonce.
 */
export function createControlVerifier(db: Db): (call: ToolCall, control: ControlDecision | null) => Promise<{ ok: boolean; reason: string }> {
  return async (call, control) => {
    if (!control) return { ok: false, reason: 'no ControlDecision bound to this call' };
    const row = await db.query<{ body: unknown; revoked_at: unknown; consumed_at: unknown }>(
      `SELECT body, revoked_at, consumed_at FROM control_decisions WHERE control_id = $1`, [control.control_id]);
    const stored = row.rows[0];
    if (!stored) return { ok: false, reason: 'control not found' };
    const c = stored.body as ControlDecision;
    const chk = checkLoaded(call, c, stored.revoked_at, stored.consumed_at);
    if (!chk.ok) return chk;
    const now = await authorityVersion(db, call.tenantId, { tool: call.tool, args: call.args });
    if (c.authorization_version !== now) return { ok: false, reason: 'authorization changed after the control was issued' };
    return { ok: true, reason: 'ok' };
  };
}
