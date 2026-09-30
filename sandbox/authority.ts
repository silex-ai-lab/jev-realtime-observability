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
    // SOC domain (docs/CONTRACTS.md §11.3). Read-only; never writes. `alert` returns the raw_log, which
    // the driver uses to build the pre_input excerpt (a source with no instruction authority).
    async alert(tenantId, alertId) {
      const r = await db.query<{ alert_id: string; title: string; entity_user: string | null; entity_ip: string | null; host: string | null; raw_log: string }>(
        `SELECT alert_id, title, entity_user, entity_ip, host, raw_log FROM sandbox.soc_alerts WHERE tenant_id = $1 AND alert_id = $2`, [tenantId, alertId]);
      const x = r.rows[0];
      return x ? { alert_id: x.alert_id, title: x.title, entity_user: x.entity_user, entity_ip: x.entity_ip, host: x.host, raw_log: x.raw_log } : null;
    },
    async user(tenantId, userId) {
      const r = await db.query<{ user_id: string; role: string; privileged: boolean; break_glass: boolean; status: 'active' | 'suspended'; host: string | null }>(
        `SELECT user_id, role, privileged, break_glass, status, host FROM sandbox.soc_users WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
      const x = r.rows[0];
      return x ? { user_id: x.user_id, role: x.role, privileged: x.privileged, break_glass: x.break_glass, status: x.status, host: x.host } : null;
    },
    async incident(tenantId, targetUser, action) {
      const r = await db.query<{ incident_id: string; target_user: string; action: string; status: 'approved' | 'pending' | 'rejected'; approved_by: string | null }>(
        `SELECT incident_id, target_user, action, status, approved_by FROM sandbox.soc_incidents WHERE tenant_id = $1 AND target_user = $2 AND action = $3 LIMIT 1`, [tenantId, targetUser, action]);
      const x = r.rows[0];
      return x ? { incident_id: x.incident_id, target_user: x.target_user, action: x.action, status: x.status, approved_by: x.approved_by } : null;
    },
    async changeApproval(tenantId, ip, action) {
      const r = await db.query<{ change_id: string; ip: string; action: string; status: 'approved' | 'pending' | 'rejected' }>(
        `SELECT change_id, ip, action, status FROM sandbox.soc_change_approvals WHERE tenant_id = $1 AND ip = $2 AND action = $3 LIMIT 1`, [tenantId, ip, action]);
      const x = r.rows[0];
      return x ? { change_id: x.change_id, ip: x.ip, action: x.action, status: x.status } : null;
    },
    async firewallLists(tenantId) {
      const r = await db.query<{ ip: string; list: string }>(
        `SELECT ip, list FROM sandbox.soc_firewall_rules WHERE tenant_id = $1 ORDER BY ip, list`, [tenantId]);
      return { allow: r.rows.filter(x => x.list === 'allow').map(x => x.ip), deny: r.rows.filter(x => x.list === 'deny').map(x => x.ip) };
    },
    async ticket(tenantId, ticketId) {
      const r = await db.query<{ ticket_id: string; status: string; alert_id: string }>(
        `SELECT ticket_id, status, alert_id FROM sandbox.soc_tickets WHERE tenant_id = $1 AND ticket_id = $2`, [tenantId, ticketId]);
      const x = r.rows[0];
      return x ? { ticket_id: x.ticket_id, status: x.status, alert_id: x.alert_id } : null;
    },
    async webhookByOperation(tenantId, operationId) {
      const r = await db.query<{ delivery_id: string; url: string; body_digest: string }>(
        `SELECT delivery_id, url, body_digest FROM sandbox.soc_webhook_sink WHERE tenant_id = $1 AND operation_id = $2 LIMIT 1`, [tenantId, operationId]);
      const x = r.rows[0];
      return x ? { delivery_id: x.delivery_id, url: x.url, digest: x.body_digest } : null;
    },
  };
}
