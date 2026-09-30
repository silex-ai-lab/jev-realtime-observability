// T1 (deepseek): sandbox/schema.sql (Postgres schema "sandbox"), sandbox/seed.ts,
// sandbox/authority.ts, sandbox/gateway.ts, sandbox/tools/*. Synthetic, fictional AP data only.
// Tools really execute: they read and write sandbox tables. No real money, no real email,
// no network egress: email.send writes to sandbox.mail_sink.
import type { Db } from '../server/storage/db.ts';
import type { ControlDecision, ExecutionReceipt } from '../contracts/decision.ts';
import { digestOf } from '../contracts/canonical.ts';
import { createAuthorityReader as authorityReader } from './authority.ts';
import { createToolGateway as toolGateway } from './gateway.ts';
import { seedSandbox as seedSandboxImpl } from './seed.ts';

/** Read-only view of authoritative records (RFC §8: separate read-only credentials in spirit). */
export interface AuthorityReader {
  tenantPolicy(tenantId: string): Promise<{ approval_limit_usd: number; domain_allowlist: string[]; stale_after_ms: number; repeat_failure_n: number } | null>;
  purchaseOrder(tenantId: string, poId: string): Promise<{ po_id: string; vendor_id: string; amount_usd: number; status: string; version: number } | null>;
  invoice(tenantId: string, invoiceId: string): Promise<{ invoice_id: string; po_id: string; vendor_name: string; amount_usd: number; note: string | null } | null>;
  approvalForInvoice(tenantId: string, invoiceId: string): Promise<{ approval_id: string; status: 'approved' | 'pending' | 'rejected'; approver: string } | null>;
  vendor(tenantId: string, vendorId: string): Promise<{ vendor_id: string; legal_name: string; aliases: string[] } | null>;
  /** Holder name and whether the registry verifies a link between this account and the vendor. Never returns the account number. */
  account(tenantId: string, accountRef: string): Promise<{ account_ref: string; holder_name: string; linked_vendor_ids: string[] } | null>;
  ledgerByOperation(tenantId: string, operationId: string): Promise<{ tx_id: string; status: 'posted' | 'pending' | 'failed'; amount_usd: number; payee: string } | null>;
  mailByOperation(tenantId: string, operationId: string): Promise<{ message_id: string; to: string; digest: string } | null>;
  // SOC domain (docs/CONTRACTS.md §11). Optional: a reader without them serves the AP domain only.
  /** The alert as the SIEM stored it. `raw_log` is attacker-influenced text: a source with no instruction authority. */
  alert?(tenantId: string, alertId: string): Promise<SocAlert | null>;
  user?(tenantId: string, userId: string): Promise<SocUser | null>;
  /** An incident authorising `action` on `targetUser`, if one exists (any status). */
  incident?(tenantId: string, targetUser: string, action: string): Promise<{ incident_id: string; target_user: string; action: string; status: 'approved' | 'pending' | 'rejected'; approved_by: string | null } | null>;
  /** A change approval for `action` on `ip`, if one exists (any status). */
  changeApproval?(tenantId: string, ip: string, action: string): Promise<{ change_id: string; ip: string; action: string; status: 'approved' | 'pending' | 'rejected' } | null>;
  firewallLists?(tenantId: string): Promise<{ allow: string[]; deny: string[] }>;
  ticket?(tenantId: string, ticketId: string): Promise<{ ticket_id: string; status: string; alert_id: string | null } | null>;
  webhookByOperation?(tenantId: string, operationId: string): Promise<{ delivery_id: string; url: string; digest: string } | null>;
}

export interface SocAlert { alert_id: string; title: string; entity_user: string | null; entity_ip: string | null; host: string | null; raw_log: string }
export interface SocUser { user_id: string; role: string; privileged: boolean; break_glass: boolean; status: 'active' | 'suspended'; host: string | null }

export interface ToolCall {
  tenantId: string;
  runId: string;
  tool: string;
  operationId: string;
  args: Record<string, unknown>;
}

export interface ToolExecution {
  receipt: ExecutionReceipt;
  /** What the tool returns to the agent (what an agent would see). */
  result: { status: 'ok' | 'error'; http_status: number; body: Record<string, unknown> };
}

export interface ToolGatewayOptions {
  /**
   * Gate C only. When true, a ControlDecision is mandatory for GATED_TOOLS
   * (payments.execute, email.send); read tools execute as in shadow mode. Without it the
   * Gateway A/B shadow behaviour is unchanged (a bare requireControl still gates every tool).
   */
  gate?: boolean;
  /**
   * The verifier used for gated calls. In gate mode this is createControlVerifier(db): it loads
   * the ControlDecision from control_decisions by control_id and never trusts a caller-supplied
   * body. On failure execute() returns receipt status 'not_executed' and performs no side effect.
   */
  requireControl?: (call: ToolCall, control: ControlDecision | null) => Promise<{ ok: boolean; reason: string }>;
  /**
   * Test-only hook, invoked in gate mode after the outside pre-check and before the consume
   * transaction opens. Used to prove a concurrent authority change (e.g. revokeApproval) is caught
   * by the in-transaction check.
   */
  onBeforeGateTx?: (call: ToolCall, control: ControlDecision | null) => Promise<void>;
}

export interface ToolGateway {
  /** Executes for real against sandbox tables. Idempotent by (tenant, operation_id): a repeat returns the first receipt and writes nothing. */
  execute(call: ToolCall, control?: ControlDecision | null): Promise<ToolExecution>;
  tools(): string[];
}

export function createAuthorityReader(db: Db): AuthorityReader {
  return authorityReader(db);
}
export function createToolGateway(db: Db, opts?: ToolGatewayOptions): ToolGateway {
  return toolGateway(db, opts);
}
/** Applies sandbox/schema.sql (via storage migrate with set "sandbox") and seeds tenant data. Idempotent. */
export async function seedSandbox(db: Db, tenantId: string): Promise<void> {
  return seedSandboxImpl(db, tenantId);
}
/** Canonical args digest: sha256 over canonical JSON (sorted keys, no whitespace). Shared by SDK, gateway and preflight. */
export function argsDigest(args: Record<string, unknown>): string {
  return digestOf(args);
}
