// Read-only view of authoritative sandbox records (RFC §8: separate read-only credentials in spirit).
// Never returns an account number. Only reads, never writes.
import type { Db } from '../server/storage/db.ts';
import type { AuthorityReader } from './index.ts';
import { effectiveLedgerStatus } from './settlement.ts';

const toMs = (v: unknown): number => (v instanceof Date ? v.getTime() : Date.parse(String(v)));

const arr = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p.map(String) : []; } catch { return []; } }
  return [];
};

export function createAuthorityReader(db: Db): AuthorityReader {
  return {
    async tenantPolicy(tenantId) {
      const r = await db.query<{ approval_limit_usd: number; domain_allowlist: unknown; stale_after_ms: number; repeat_failure_n: number }>(
        `SELECT approval_limit_usd, domain_allowlist, stale_after_ms, repeat_failure_n FROM sandbox.tenant_policies WHERE tenant_id = $1`, [tenantId]);
      const x = r.rows[0];
      if (!x) return null;
      return { approval_limit_usd: x.approval_limit_usd, domain_allowlist: arr(x.domain_allowlist), stale_after_ms: x.stale_after_ms, repeat_failure_n: x.repeat_failure_n };
    },
    async purchaseOrder(tenantId, poId) {
      const r = await db.query<{ po_id: string; vendor_id: string; amount_usd: number; status: string; version: number }>(
        `SELECT po_id, vendor_id, amount_usd, status, version FROM sandbox.purchase_orders WHERE tenant_id = $1 AND po_id = $2`, [tenantId, poId]);
      const x = r.rows[0];
      return x ? { po_id: x.po_id, vendor_id: x.vendor_id, amount_usd: x.amount_usd, status: x.status, version: x.version } : null;
    },
    async invoice(tenantId, invoiceId) {
      const r = await db.query<{ invoice_id: string; po_id: string; vendor_name: string; amount_usd: number; note: string | null }>(
        `SELECT invoice_id, po_id, vendor_name, amount_usd, note FROM sandbox.invoices WHERE tenant_id = $1 AND invoice_id = $2`, [tenantId, invoiceId]);
      const x = r.rows[0];
      return x ? { invoice_id: x.invoice_id, po_id: x.po_id, vendor_name: x.vendor_name, amount_usd: x.amount_usd, note: x.note } : null;
    },
    async approvalForInvoice(tenantId, invoiceId) {
      const r = await db.query<{ approval_id: string; status: 'approved' | 'pending' | 'rejected'; approver: string }>(
        `SELECT approval_id, status, approver FROM sandbox.approvals WHERE tenant_id = $1 AND invoice_id = $2 LIMIT 1`, [tenantId, invoiceId]);
      const x = r.rows[0];
      return x ? { approval_id: x.approval_id, status: x.status, approver: x.approver } : null;
    },
    async vendor(tenantId, vendorId) {
      const r = await db.query<{ vendor_id: string; legal_name: string; aliases: unknown }>(
        `SELECT vendor_id, legal_name, aliases FROM sandbox.vendors WHERE tenant_id = $1 AND vendor_id = $2`, [tenantId, vendorId]);
      const x = r.rows[0];
      return x ? { vendor_id: x.vendor_id, legal_name: x.legal_name, aliases: arr(x.aliases) } : null;
    },
    async account(tenantId, accountRef) {
      const r = await db.query<{ account_ref: string; holder_name: string }>(
        `SELECT account_ref, holder_name FROM sandbox.accounts WHERE tenant_id = $1 AND account_ref = $2`, [tenantId, accountRef]);
      const x = r.rows[0];
      if (!x) return null;
      const links = await db.query<{ vendor_id: string }>(`SELECT vendor_id FROM sandbox.account_vendors WHERE tenant_id = $1 AND account_ref = $2 ORDER BY vendor_id`, [tenantId, accountRef]);
      return { account_ref: x.account_ref, holder_name: x.holder_name, linked_vendor_ids: links.rows.map(l => l.vendor_id) };
    },
    async ledgerByOperation(tenantId, operationId) {
      const r = await db.query<{ tx_id: string; settlement: string; created_at: unknown; amount_usd: number; payee: string }>(
        `SELECT tx_id, settlement, created_at, amount_usd, payee FROM sandbox.ledger WHERE tenant_id = $1 AND operation_id = $2 LIMIT 1`, [tenantId, operationId]);
      const x = r.rows[0];
      if (!x) return null;
      const status = effectiveLedgerStatus(x.settlement, toMs(x.created_at), Date.now());
      return { tx_id: x.tx_id, status, amount_usd: x.amount_usd, payee: x.payee };
    },
    async mailByOperation(tenantId, operationId) {
      const r = await db.query<{ message_id: string; to_addr: string; body_digest: string }>(
        `SELECT message_id, to_addr, body_digest FROM sandbox.mail_sink WHERE tenant_id = $1 AND operation_id = $2 LIMIT 1`, [tenantId, operationId]);
      const x = r.rows[0];
      return x ? { message_id: x.message_id, to: x.to_addr, digest: x.body_digest } : null;
    },
  };
}
