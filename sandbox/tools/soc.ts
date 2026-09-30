// SOC-triage tools (docs/CONTRACTS.md §11.3). They validate input and existence only — they never
// enforce policy. A real IAM/firewall API lets a privileged agent act, and policy is Silex's job, so
// in shadow mode the harmful actions really execute (the SOC2 allowlist write, the SOC3 suspend, etc.).
import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../server/storage/db.ts';
import { sha256 } from '../../contracts/canonical.ts';
import type { ToolCall } from '../index.ts';
import type { ToolOutcome } from './index.ts';

const ok = (body: Record<string, unknown>, resource_ref: string | null = null): ToolOutcome =>
  ({ ok: true, refused: false, http_status: 200, body, resource_ref });
const error = (http_status: number, message: string): ToolOutcome =>
  ({ ok: false, refused: false, http_status, body: { error: message }, resource_ref: null });

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const isIPv4 = (v: unknown): v is string => typeof v === 'string' && IPV4.test(v);

async function siemSearch(db: Queryable, call: ToolCall): Promise<ToolOutcome> {
  const alertId = call.args.alert_id;
  const r = await db.query<{ alert_id: string; title: string; entity_user: string | null; entity_ip: string | null; host: string | null; raw_log: string }>(
    `SELECT alert_id, title, entity_user, entity_ip, host, raw_log FROM sandbox.soc_alerts WHERE tenant_id = $1 AND alert_id = $2`, [call.tenantId, alertId]);
  const x = r.rows[0];
  if (!x) return error(404, 'alert not found');
  return ok({ alert: { alert_id: x.alert_id, title: x.title, entity_user: x.entity_user, entity_ip: x.entity_ip, host: x.host, raw_log: x.raw_log } });
}

async function suspendUser(db: Queryable, call: ToolCall): Promise<ToolOutcome> {
  const userId = call.args.user_id;
  const r = await db.query<{ status: string }>(
    `SELECT status FROM sandbox.soc_users WHERE tenant_id = $1 AND user_id = $2`, [call.tenantId, userId]);
  const x = r.rows[0];
  if (!x) return error(404, 'user not found');
  if (x.status === 'suspended') return error(409, 'user already suspended');
  await db.query(`UPDATE sandbox.soc_users SET status = 'suspended' WHERE tenant_id = $1 AND user_id = $2`, [call.tenantId, userId]);
  return ok({ user_id: userId, status: 'suspended' });
}

async function blockIp(db: Queryable, call: ToolCall): Promise<ToolOutcome> {
  const ip = call.args.ip;
  if (!isIPv4(ip)) return error(400, 'invalid IPv4 address');
  await db.query(`INSERT INTO sandbox.soc_firewall_rules (tenant_id, ip, list, operation_id, reason) VALUES ($1, $2, 'deny', $3, $4) ON CONFLICT (tenant_id, ip, list) DO NOTHING`,
    [call.tenantId, ip, call.operationId, String(call.args.reason ?? '')]);
  return ok({ ip, list: 'deny' });
}

async function allowlistIp(db: Queryable, call: ToolCall): Promise<ToolOutcome> {
  const ip = call.args.ip;
  if (!isIPv4(ip)) return error(400, 'invalid IPv4 address');
  await db.query(`INSERT INTO sandbox.soc_firewall_rules (tenant_id, ip, list, operation_id, reason) VALUES ($1, $2, 'allow', $3, $4) ON CONFLICT (tenant_id, ip, list) DO NOTHING`,
    [call.tenantId, ip, call.operationId, String(call.args.reason ?? '')]);
  return ok({ ip, list: 'allow' });
}

async function ticketUpdate(db: Queryable, call: ToolCall): Promise<ToolOutcome> {
  const ticketId = call.args.ticket_id;
  const r = await db.query<{ ticket_id: string }>(
    `SELECT ticket_id FROM sandbox.soc_tickets WHERE tenant_id = $1 AND ticket_id = $2`, [call.tenantId, ticketId]);
  if (!r.rows[0]) return error(404, 'ticket not found');
  const status = typeof call.args.status === 'string' ? call.args.status : 'investigating';
  const note = typeof call.args.note === 'string' ? call.args.note : '';
  await db.query(`UPDATE sandbox.soc_tickets SET status = $3, note = $4 WHERE tenant_id = $1 AND ticket_id = $2`, [call.tenantId, ticketId, status, note]);
  return ok({ ticket_id: ticketId, status });
}

async function webhookPost(db: Queryable, call: ToolCall): Promise<ToolOutcome> {
  const url = call.args.url;
  let parsed: URL | null = null;
  try { parsed = typeof url === 'string' ? new URL(url) : null; } catch { parsed = null; }
  if (typeof url !== 'string' || !parsed || parsed.protocol !== 'https:' || !parsed.hostname) return error(400, 'not a valid https URL');
  const body = typeof call.args.body === 'string' ? call.args.body : '';
  const deliveryId = `del-${randomUUID()}`;
  await db.query(`INSERT INTO sandbox.soc_webhook_sink (tenant_id, delivery_id, operation_id, url, body_digest) VALUES ($1, $2, $3, $4, $5)`,
    [call.tenantId, deliveryId, call.operationId, url, sha256(body)]);
  return ok({ delivery_id: deliveryId, url }, deliveryId);
}

export const SOC_HANDLERS: Record<string, (db: Queryable, call: ToolCall) => Promise<ToolOutcome>> = {
  'siem.search': siemSearch,
  'identity.suspend_user': suspendUser,
  'firewall.block_ip': blockIp,
  'firewall.allowlist_ip': allowlistIp,
  'ticket.update': ticketUpdate,
  'webhook.post': webhookPost,
};

export const SOC_TOOL_NAMES = ['siem.search', 'identity.suspend_user', 'firewall.block_ip', 'firewall.allowlist_ip', 'ticket.update', 'webhook.post'] as const;
