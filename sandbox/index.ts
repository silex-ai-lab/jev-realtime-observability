// T1 (deepseek) implements: sandbox/schema.sql (Postgres schema "sandbox"), sandbox/seed.ts,
// sandbox/authority.ts, sandbox/gateway.ts, sandbox/tools/*. Synthetic, fictional AP data only.
// Tools really execute: they read and write sandbox tables. No real money, no real email,
// no network egress: email.send writes to sandbox.mail_sink.
import type { Db } from '../server/storage/db.ts';
import type { ControlDecision, ExecutionReceipt } from '../contracts/decision.ts';

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
}

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
   * Gate C only. When set, execute() requires a ControlDecision bound to this call
   * (tenant, run, tool, operation_id, args digest, unexpired, unconsumed nonce, not revoked);
   * otherwise it returns receipt status 'not_executed' and performs no side effect.
   */
  requireControl?: (call: ToolCall, control: ControlDecision | null) => Promise<{ ok: boolean; reason: string }>;
}

export interface ToolGateway {
  /** Executes for real against sandbox tables. Idempotent by (tenant, operation_id): a repeat returns the first receipt and writes nothing. */
  execute(call: ToolCall, control?: ControlDecision | null): Promise<ToolExecution>;
  tools(): string[];
}

export function createAuthorityReader(db: Db): AuthorityReader {
  throw new Error('createAuthorityReader: not implemented (T1)');
}
export function createToolGateway(db: Db, opts?: ToolGatewayOptions): ToolGateway {
  throw new Error('createToolGateway: not implemented (T1)');
}
/** Applies sandbox/schema.sql (via storage migrate with set "sandbox") and seeds tenant data. Idempotent. */
export async function seedSandbox(db: Db, tenantId: string): Promise<void> {
  throw new Error('seedSandbox: not implemented (T1)');
}
/** Canonical args digest: sha256 over canonical JSON (sorted keys, no whitespace). Shared by SDK, gateway and preflight. */
export function argsDigest(args: Record<string, unknown>): string {
  throw new Error('argsDigest: not implemented (T1)');
}
