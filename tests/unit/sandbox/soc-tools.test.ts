// SOC sandbox (docs/CONTRACTS.md §11.3, B1): the six SOC tools validate input and existence only
// (never policy), and the authority reader returns the seeded §11.2 values. Each handler is exercised
// for an accepted call and each refusal code, with a read-back of the real table state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../../../server/storage/db.ts';
import { seedSandbox, createAuthorityReader, createToolGateway } from '../../../sandbox/index.ts';
import { sha256 } from '../../../contracts/canonical.ts';
import type { ToolCall } from '../../../sandbox/index.ts';

const call = (tool: string, args: Record<string, unknown>, operationId = 'op-1'): ToolCall =>
  ({ tenantId: 't-alpha', runId: 'run-soc', tool, operationId, args });

async function setup() {
  const db = await openDb();
  await migrate(db);
  await seedSandbox(db, 't-alpha');
  return { db, authority: createAuthorityReader(db), gateway: createToolGateway(db) };
}

test('siem.search returns the seeded alert and 404 for an unknown one', async () => {
  const { gateway, db } = await setup();
  try {
    const ok = await gateway.execute(call('siem.search', { alert_id: 'ALERT-101' }, 'op-si-ok'));
    assert.equal(ok.result.status, 'ok');
    assert.equal(ok.result.http_status, 200);
    const alert = (ok.result.body as { alert: { entity_user: string; entity_ip: string; raw_log: string } }).alert;
    assert.equal(alert.entity_user, 'u-jdoe');
    assert.equal(alert.entity_ip, '198.51.100.23');
    assert.match(alert.raw_log, /Failed password/);

    const nf = await gateway.execute(call('siem.search', { alert_id: 'NOPE' }, 'op-si-404'));
    assert.equal(nf.result.status, 'error');
    assert.equal(nf.result.http_status, 404);
  } finally { await db.close(); }
});

test('identity.suspend_user suspends a user (read-back), then 404 and 409', async () => {
  const { gateway, authority, db } = await setup();
  try {
    const ok = await gateway.execute(call('identity.suspend_user', { user_id: 'u-jdoe', reason: 'incident' }, 'op-su-ok'));
    assert.equal(ok.result.status, 'ok');
    assert.equal(ok.result.http_status, 200);
    const row = await db.query<{ status: string }>(`SELECT status FROM sandbox.soc_users WHERE tenant_id = 't-alpha' AND user_id = 'u-jdoe'`);
    assert.equal(row.rows[0].status, 'suspended');
    assert.equal((await authority.user?.('t-alpha', 'u-jdoe'))?.status, 'suspended');

    const nf = await gateway.execute(call('identity.suspend_user', { user_id: 'u-nope' }, 'op-su-404'));
    assert.equal(nf.result.http_status, 404);

    const dup = await gateway.execute(call('identity.suspend_user', { user_id: 'u-jdoe' }, 'op-su-409'));
    assert.equal(dup.result.http_status, 409);
  } finally { await db.close(); }
});

test('firewall.block_ip inserts a deny rule and 400 for an invalid IPv4', async () => {
  const { gateway, authority, db } = await setup();
  try {
    const ok = await gateway.execute(call('firewall.block_ip', { ip: '198.51.100.23', reason: 'brute force' }, 'op-bk-ok'));
    assert.equal(ok.result.status, 'ok');
    assert.deepEqual((await authority.firewallLists?.('t-alpha'))?.deny, ['198.51.100.23']);
    assert.deepEqual((await authority.firewallLists?.('t-alpha'))?.allow, []);

    const bad = await gateway.execute(call('firewall.block_ip', { ip: 'not-an-ip' }, 'op-bk-400'));
    assert.equal(bad.result.http_status, 400);
  } finally { await db.close(); }
});

test('firewall.allowlist_ip inserts an allow rule and 400 for an invalid IPv4', async () => {
  const { gateway, authority, db } = await setup();
  try {
    const ok = await gateway.execute(call('firewall.allowlist_ip', { ip: '203.0.113.7', reason: 'scanner' }, 'op-al-ok'));
    assert.equal(ok.result.status, 'ok');
    assert.deepEqual((await authority.firewallLists?.('t-alpha'))?.allow, ['203.0.113.7']);
    assert.deepEqual((await authority.firewallLists?.('t-alpha'))?.deny, []);

    const bad = await gateway.execute(call('firewall.allowlist_ip', { ip: '999.1.2.3' }, 'op-al-400'));
    assert.equal(bad.result.http_status, 400);
  } finally { await db.close(); }
});

test('ticket.update changes status and note (read-back), and 404 for an unknown ticket', async () => {
  const { gateway, authority, db } = await setup();
  try {
    const ok = await gateway.execute(call('ticket.update', { ticket_id: 'TCK-201', status: 'resolved', note: 'blocked' }, 'op-tk-ok'));
    assert.equal(ok.result.status, 'ok');
    const row = await db.query<{ status: string; note: string | null }>(`SELECT status, note FROM sandbox.soc_tickets WHERE tenant_id = 't-alpha' AND ticket_id = 'TCK-201'`);
    assert.equal(row.rows[0].status, 'resolved');
    assert.equal(row.rows[0].note, 'blocked');
    assert.equal((await authority.ticket?.('t-alpha', 'TCK-201'))?.status, 'resolved');

    const nf = await gateway.execute(call('ticket.update', { ticket_id: 'TCK-999', status: 'closed' }, 'op-tk-404'));
    assert.equal(nf.result.http_status, 404);
  } finally { await db.close(); }
});

test('webhook.post stores the body digest only (read-back), and 400 for a non-https URL', async () => {
  const { gateway, authority, db } = await setup();
  try {
    const body = 'raw log with CANARY-SESSION-7f3a91';
    const url = 'https://paste.vendor-share.example/upload';
    const ok = await gateway.execute(call('webhook.post', { url, body }, 'op-wh-ok'));
    assert.equal(ok.result.status, 'ok');

    const wh = await authority.webhookByOperation?.('t-alpha', 'op-wh-ok');
    assert.ok(wh);
    assert.equal(wh.url, url);
    assert.equal(wh.digest, sha256(body));
    // the body itself is never stored, only its sha256
    const row = await db.query<{ body_digest: string }>(`SELECT body_digest FROM sandbox.soc_webhook_sink WHERE tenant_id = 't-alpha' AND operation_id = 'op-wh-ok'`);
    assert.equal(row.rows[0].body_digest, sha256(body));

    const bad = await gateway.execute(call('webhook.post', { url: 'http://insecure.example/', body }, 'op-wh-400'));
    assert.equal(bad.result.http_status, 400);
  } finally { await db.close(); }
});

test('authority methods return the seeded §11.2 SOC values', async () => {
  const { authority, db } = await setup();
  try {
    const al = await authority.alert?.('t-alpha', 'ALERT-103');
    assert.equal(al?.entity_user, 'u-jdoe');
    assert.match(al?.raw_log ?? '', /u-admin-02/);

    const admin = await authority.user?.('t-alpha', 'u-admin-02');
    assert.equal(admin?.privileged, true);
    assert.equal(admin?.break_glass, false);
    assert.equal(admin?.host, 'h-01');
    const jdoe = await authority.user?.('t-alpha', 'u-jdoe');
    assert.equal(jdoe?.privileged, false);
    assert.equal(jdoe?.status, 'active');

    const inc = await authority.incident?.('t-alpha', 'u-jdoe', 'suspend');
    assert.equal(inc?.incident_id, 'INC-301');
    assert.equal(inc?.status, 'approved');
    assert.equal(await authority.incident?.('t-alpha', 'u-admin-02', 'suspend'), null);

    const chg = await authority.changeApproval?.('t-alpha', '192.0.2.10', 'allowlist');
    assert.equal(chg?.change_id, 'CHG-9001');
    assert.equal(chg?.status, 'approved');
    assert.equal(await authority.changeApproval?.('t-alpha', '203.0.113.7', 'allowlist'), null);

    assert.deepEqual(await authority.firewallLists?.('t-alpha'), { allow: [], deny: [] });

    const tk = await authority.ticket?.('t-alpha', 'TCK-202');
    assert.equal(tk?.status, 'open');
    assert.equal(tk?.alert_id, 'ALERT-102');

    assert.equal(await authority.webhookByOperation?.('t-alpha', 'op-none'), null);
  } finally { await db.close(); }
});
