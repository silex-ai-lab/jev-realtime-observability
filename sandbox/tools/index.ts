// The five sandbox tools (rubrics/rubric-manifest.v1.json tool_registry). Each tool keeps its own
// basic authorization independent of the decision plane (RFC §2 invariant, §12.3): payments.execute
// refuses over-limit, unapproved or args-inconsistent payments; email.send refuses non-allowlisted
// recipients. Everything else executes for real against sandbox tables. No network, no real money.
import { randomUUID } from 'node:crypto';
import type { Db } from '../../server/storage/db.ts';
import { sha256 } from '../../contracts/canonical.ts';
import type { ToolCall } from '../index.ts';
import { effectiveLedgerStatus } from '../settlement.ts';

const toMs = (v: unknown): number => (v instanceof Date ? v.getTime() : Date.parse(String(v)));

export interface ToolOutcome {
  /** The operation completed (even if the answer is "not found"). */
  ok: boolean;
  /** Refused by tool-level authorization (receipt becomes 'failed', no side effect). */
  refused: boolean;
  http_status: number;
  body: Record<string, unknown>;
  resource_ref: string | null;
}

export const TOOL_NAMES = ['erp.get_po', 'vendor.lookup', 'erp.payment_status', 'email.send', 'payments.execute'] as const;

const domainOf = (addr: unknown): string | null => (typeof addr === 'string' && addr.includes('@')) ? addr.split('@').pop()!.toLowerCase() : null;

const ok = (http_status: number, body: Record<string, unknown>, resource_ref: string | null = null): ToolOutcome =>
  ({ ok: true, refused: false, http_status, body, resource_ref });
const notFound = (what: string): ToolOutcome => ({ ok: false, refused: false, http_status: 404, body: { error: `${what} not found` }, resource_ref: null });
const refuse = (reason: string): ToolOutcome => ({ ok: false, refused: true, http_status: 403, body: { error: reason }, resource_ref: null });

async function erpGetPo(db: Db, call: ToolCall): Promise<ToolOutcome> {
  const poId = call.args.po_id;
  const r = await db.query<{ po_id: string; vendor_id: string; amount_usd: number; status: string; version: number }>(
    `SELECT po_id, vendor_id, amount_usd, status, version FROM sandbox.purchase_orders WHERE tenant_id = $1 AND po_id = $2`, [call.tenantId, poId]);
  const x = r.rows[0];
  if (!x) return notFound('purchase order');
  return ok(200, { po: { po_id: x.po_id, vendor_id: x.vendor_id, amount_usd: x.amount_usd, status: x.status, version: x.version } });
}

async function vendorLookup(db: Db, call: ToolCall): Promise<ToolOutcome> {
  const vendorId = call.args.vendor_id;
  const r = await db.query<{ vendor_id: string; legal_name: string; aliases: unknown }>(
    `SELECT vendor_id, legal_name, aliases FROM sandbox.vendors WHERE tenant_id = $1 AND vendor_id = $2`, [call.tenantId, vendorId]);
  const x = r.rows[0];
  if (!x) return notFound('vendor');
  const aliases = Array.isArray(x.aliases) ? x.aliases.map(String) : [];
  return ok(200, { vendor: { vendor_id: x.vendor_id, legal_name: x.legal_name, aliases } });
}

async function erpPaymentStatus(db: Db, call: ToolCall): Promise<ToolOutcome> {
  const operationId = call.args.operation_id;
  const r = await db.query<{ tx_id: string; settlement: string; created_at: unknown; amount_usd: number }>(
    `SELECT tx_id, settlement, created_at, amount_usd FROM sandbox.ledger WHERE tenant_id = $1 AND operation_id = $2 LIMIT 1`, [call.tenantId, operationId]);
  const x = r.rows[0];
  if (!x) return ok(200, { operation_id: operationId, posted: false, tx_id: null });
  const status = effectiveLedgerStatus(x.settlement, toMs(x.created_at), Date.now());
  return ok(200, { operation_id: operationId, posted: status === 'posted', status, tx_id: x.tx_id, amount_usd: x.amount_usd });
}

async function emailSend(db: Db, call: ToolCall): Promise<ToolOutcome> {
  const to = call.args.to;
  const domain = domainOf(to);
  const policy = await db.query<{ domain_allowlist: unknown }>(`SELECT domain_allowlist FROM sandbox.tenant_policies WHERE tenant_id = $1`, [call.tenantId]);
  const allowlist = (Array.isArray(policy.rows[0]?.domain_allowlist) ? policy.rows[0].domain_allowlist : []).map(String);
  if (!domain || !allowlist.includes(domain)) return refuse(`recipient domain ${domain ?? '(none)'} is not in the tenant allowlist`);
  const messageId = `msg-${randomUUID()}`;
  const body = typeof call.args.body === 'string' ? call.args.body : '';
  await db.query(`INSERT INTO sandbox.mail_sink (tenant_id, message_id, operation_id, to_addr, subject, body_digest) VALUES ($1, $2, $3, $4, $5, $6)`,
    [call.tenantId, messageId, call.operationId, String(to), String(call.args.subject ?? ''), sha256(body)]);
  return ok(200, { message_id: messageId }, messageId);
}

async function paymentsExecute(db: Db, call: ToolCall): Promise<ToolOutcome> {
  const { invoice_id: invoiceId, po_id: poId, amount_usd: amountUsd, payee, account_ref: accountRef } = call.args;
  const inv = await db.query<{ invoice_id: string; po_id: string; vendor_name: string; amount_usd: number; settlement: string }>(
    `SELECT invoice_id, po_id, vendor_name, amount_usd, settlement FROM sandbox.invoices WHERE tenant_id = $1 AND invoice_id = $2`, [call.tenantId, invoiceId]);
  if (!inv.rows[0]) return refuse('invoice not found');

  const amount = typeof amountUsd === 'number' && Number.isFinite(amountUsd) ? amountUsd : null;
  if (amount == null) return refuse('invalid amount_usd');
  if (amount !== inv.rows[0].amount_usd) return refuse('args inconsistent with invoice: amount differs');
  if (payee !== inv.rows[0].vendor_name) return refuse('args inconsistent with invoice: payee differs');

  const appr = await db.query<{ approval_id: string }>(
    `SELECT approval_id FROM sandbox.approvals WHERE tenant_id = $1 AND invoice_id = $2 AND status = 'approved' LIMIT 1`, [call.tenantId, invoiceId]);
  if (!appr.rows[0]) return refuse('no approved approval for the invoice');

  const policy = await db.query<{ approval_limit_usd: number }>(`SELECT approval_limit_usd FROM sandbox.tenant_policies WHERE tenant_id = $1`, [call.tenantId]);
  if (policy.rows[0] && amount > policy.rows[0].approval_limit_usd) return refuse('amount exceeds the tenant approval limit');

  const txId = `tx-${randomUUID()}`;
  const settlement = inv.rows[0].settlement;
  await db.query(
    `INSERT INTO sandbox.ledger (tenant_id, tx_id, operation_id, invoice_id, amount_usd, payee, account_ref, settlement) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [call.tenantId, txId, call.operationId, String(invoiceId), amount, String(payee), String(accountRef), settlement],
  );
  // HTTP 200 on insert; the *effective* status is settlement-dependent (S5: 200 does not mean done).
  const status = effectiveLedgerStatus(settlement, Date.now(), Date.now());
  return ok(200, { tx_id: txId, settlement, status, invoice_id: invoiceId, po_id: poId }, txId);
}

const HANDLERS: Record<string, (db: Db, call: ToolCall) => Promise<ToolOutcome>> = {
  'erp.get_po': erpGetPo,
  'vendor.lookup': vendorLookup,
  'erp.payment_status': erpPaymentStatus,
  'email.send': emailSend,
  'payments.execute': paymentsExecute,
};

export async function dispatchTool(db: Db, call: ToolCall): Promise<ToolOutcome> {
  const handler = HANDLERS[call.tool];
  if (!handler) return { ok: false, refused: true, http_status: 404, body: { error: `unknown tool ${call.tool}` }, resource_ref: null };
  return handler(db, call);
}
