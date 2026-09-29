// Gate C sandbox control (docs/CONTRACTS.md §9.1–9.3): authorityVersion, revokeApproval, and the
// gate-mode gateway that loads a ControlDecision by control_id (never trusting the caller's body),
// verifies §9.2's checks in order, consumes the nonce in the same transaction as the side effect,
// and persists receipts to execution_receipts + outbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { openDb, migrate, type Db } from '../../../server/storage/db.ts';
import { seedSandbox, createToolGateway, argsDigest } from '../../../sandbox/index.ts';
import { authorityVersion, revokeApproval, createControlVerifier, GATED_TOOLS } from '../../../sandbox/control.ts';
import type { ToolCall } from '../../../sandbox/index.ts';
import type { ControlDecision } from '../../../contracts/decision.ts';

const call = (tool: string, args: Record<string, unknown>, operationId = 'op-1'): ToolCall =>
  ({ tenantId: 't-alpha', runId: 'run-1', tool, operationId, args });

const S1 = { invoice_id: 'INV-7731', po_id: 'PO-4410', amount_usd: 8420, payee: 'Pacific Paper Co.', account_ref: 'ACCT-118-01', remit_domain: 'bank.northwind.example' };
const EMAIL = { to: 'ap@northwind.example', subject: 'hello', body: 'hi', includes_fields: [] };

async function setup() {
  const db = await openDb();
  await migrate(db);
  await seedSandbox(db, 't-alpha');
  const gateway = createToolGateway(db, { gate: true, requireControl: createControlVerifier(db) });
  return { db, gateway };
}

/** Issues a ControlDecision bound to `c` and stores it in control_decisions, as /v1/preflight does. */
async function issue(db: Db, c: ToolCall, overrides: Partial<ControlDecision> = {}): Promise<ControlDecision> {
  const control: ControlDecision = {
    control_id: `ctl-${randomUUID()}`, tenant_id: c.tenantId, run_id: c.runId, actor_id: 'agent', tool: c.tool,
    operation_id: c.operationId, args_digest: argsDigest(c.args), policy_version: 'policy-a1', snapshot_id: 'snap-1',
    authorization_version: await authorityVersion(db, c.tenantId, { tool: c.tool, args: c.args }),
    action: 'allow', issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30_000).toISOString(),
    nonce: randomBytes(16).toString('hex'),
    ...overrides,
  };
  await db.query(`INSERT INTO control_decisions (tenant_id, control_id, operation_id, nonce, body) VALUES ($1, $2, $3, $4, $5)`,
    [control.tenant_id, control.control_id, control.operation_id, control.nonce, JSON.stringify(control)]);
  return control;
}

const ledgerRows = async (db: Awaited<ReturnType<typeof openDb>>, operationId: string) =>
  (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM sandbox.ledger WHERE tenant_id = 't-alpha' AND operation_id = $1`, [operationId])).rows[0].n;
const mailRows = async (db: Awaited<ReturnType<typeof openDb>>, operationId: string) =>
  (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM sandbox.mail_sink WHERE tenant_id = 't-alpha' AND operation_id = $1`, [operationId])).rows[0].n;
const consumedAt = async (db: Awaited<ReturnType<typeof openDb>>, controlId: string) =>
  (await db.query<{ consumed_at: unknown }>(`SELECT consumed_at FROM control_decisions WHERE control_id = $1`, [controlId])).rows[0]?.consumed_at;

test('GATED_TOOLS is exactly the two write/payment tools', () => {
  assert.deepEqual([...GATED_TOOLS], ['payments.execute', 'email.send']);
});

test('authorityVersion is deterministic and changes when the approval is revoked', async () => {
  const db = await openDb();
  await migrate(db);
  await seedSandbox(db, 't-alpha');
  try {
    const c = call('payments.execute', S1);
    const before = await authorityVersion(db, 't-alpha', { tool: c.tool, args: c.args });
    assert.match(before, /^sha256:[0-9a-f]{64}$/);
    assert.equal(before, await authorityVersion(db, 't-alpha', { tool: c.tool, args: c.args }));
    await revokeApproval(db, 't-alpha', 'APR-2291');
    assert.notEqual(await authorityVersion(db, 't-alpha', { tool: c.tool, args: c.args }), before);
  } finally { await db.close(); }
});

test('allow executes once and consumes the control in the same transaction', async () => {
  const { db, gateway } = await setup();
  try {
    const c = call('payments.execute', S1, 'op-allow');
    const control = await issue(db, c);
    const exec = await gateway.execute(c, control);
    assert.equal(exec.receipt.status, 'executed');
    assert.equal(exec.result.status, 'ok');
    assert.ok(await consumedAt(db, control.control_id), 'nonce must be consumed');
    assert.equal(await ledgerRows(db, 'op-allow'), 1);
    const rec = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM execution_receipts WHERE operation_id = 'op-allow'`);
    assert.equal(rec.rows[0].n, 1);
    const ob = await db.query<{ payload: unknown }>(`SELECT payload FROM outbox WHERE kind = 'receipt' AND ref_id = $1`, [exec.receipt.receipt_id]);
    assert.equal(ob.rows.length, 1);
    assert.equal((ob.rows[0].payload as { status: string }).status, 'executed');
  } finally { await db.close(); }
});

test('email.send under an allow control executes and consumes', async () => {
  const { db, gateway } = await setup();
  try {
    const c = call('email.send', EMAIL, 'op-email');
    const control = await issue(db, c);
    const exec = await gateway.execute(c, control);
    assert.equal(exec.receipt.status, 'executed');
    assert.ok(await consumedAt(db, control.control_id));
    assert.equal(await mailRows(db, 'op-email'), 1);
  } finally { await db.close(); }
});

test('args changed after the decision are not executed (digest mismatch)', async () => {
  const { db, gateway } = await setup();
  try {
    const c = call('payments.execute', S1, 'op-digest');
    const control = await issue(db, c);
    const changed = call('payments.execute', { ...S1, amount_usd: 8421 }, 'op-digest');
    const exec = await gateway.execute(changed, control);
    assert.equal(exec.receipt.status, 'not_executed');
    assert.match(exec.receipt.reason, /digest/);
    assert.equal(await ledgerRows(db, 'op-digest'), 0);
    assert.equal(await consumedAt(db, control.control_id), null, 'a rejected call must not consume the nonce');
  } finally { await db.close(); }
});

test('an expired control is not executed', async () => {
  const { db, gateway } = await setup();
  try {
    const c = call('payments.execute', S1, 'op-expired');
    const control = await issue(db, c);
    await db.query(`UPDATE control_decisions SET body = body || jsonb_build_object('expires_at', $2::text) WHERE control_id = $1`,
      [control.control_id, new Date(Date.now() - 1_000).toISOString()]);
    const exec = await gateway.execute(c, control);
    assert.equal(exec.receipt.status, 'not_executed');
    assert.match(exec.receipt.reason, /expir/);
    assert.equal(await ledgerRows(db, 'op-expired'), 0);
    assert.equal(await mailRows(db, 'op-expired'), 0);
  } finally { await db.close(); }
});

test('an operation refused for an expired control can be retried with a fresh control and executes once', async () => {
  const { db, gateway } = await setup();
  try {
    const c = call('payments.execute', S1, 'op-retry');
    const expired = await issue(db, c);
    await db.query(`UPDATE control_decisions SET body = body || jsonb_build_object('expires_at', $2::text) WHERE control_id = $1`,
      [expired.control_id, new Date(Date.now() - 1_000).toISOString()]);
    const first = await gateway.execute(c, expired);
    assert.equal(first.receipt.status, 'not_executed');
    assert.match(first.receipt.reason, /expir/);
    assert.equal(await ledgerRows(db, 'op-retry'), 0);

    // A not_executed receipt must not wedge the idempotency key: re-preflight and retry executes.
    const fresh = await issue(db, c);
    const second = await gateway.execute(c, fresh);
    assert.equal(second.receipt.status, 'executed');
    assert.equal(await ledgerRows(db, 'op-retry'), 1);

    const third = await gateway.execute(c, fresh);
    assert.equal(third.receipt.receipt_id, second.receipt.receipt_id, 'the completed side effect is idempotent');
    assert.equal(await ledgerRows(db, 'op-retry'), 1, 'exactly one side effect');
  } finally { await db.close(); }
});

test('a revoked control is not executed', async () => {
  const { db, gateway } = await setup();
  try {
    const c = call('payments.execute', S1, 'op-revoked');
    const control = await issue(db, c);
    await db.query(`UPDATE control_decisions SET revoked_at = now() WHERE control_id = $1`, [control.control_id]);
    const exec = await gateway.execute(c, control);
    assert.equal(exec.receipt.status, 'not_executed');
    assert.match(exec.receipt.reason, /revok/);
    assert.equal(await ledgerRows(db, 'op-revoked'), 0);
  } finally { await db.close(); }
});

test('authority changed after issue (approval revoked) is not executed', async () => {
  const { db, gateway } = await setup();
  try {
    const c = call('payments.execute', S1, 'op-auth');
    const control = await issue(db, c);
    await revokeApproval(db, 't-alpha', 'APR-2291');
    const exec = await gateway.execute(c, control);
    assert.equal(exec.receipt.status, 'not_executed');
    assert.match(exec.receipt.reason, /authori|version|approval|changed|revok/i);
    assert.equal(await ledgerRows(db, 'op-auth'), 0);
  } finally { await db.close(); }
});

test('a revocation that lands after the pre-check but before the transaction is caught in-tx', async () => {
  const db = await openDb();
  await migrate(db);
  await seedSandbox(db, 't-alpha');
  try {
    const c = call('payments.execute', S1, 'op-interleave');
    const control = await issue(db, c);
    const gateway = createToolGateway(db, {
      gate: true,
      requireControl: createControlVerifier(db),
      // Test hook: revoke the approval after the outside pre-check has already passed and before the
      // consume transaction opens. Only the in-transaction authority re-check can see this change.
      onBeforeGateTx: async () => { await revokeApproval(db, 't-alpha', 'APR-2291'); },
    });
    const exec = await gateway.execute(c, control);
    assert.equal(exec.receipt.status, 'not_executed');
    assert.match(exec.receipt.reason, /authori|version|approval|changed|revok/i);
    assert.equal(await ledgerRows(db, 'op-interleave'), 0, 'the side effect must not run');
    assert.equal(await consumedAt(db, control.control_id), null, 'a refused call must not consume the nonce');
  } finally { await db.close(); }
});

test('a consumed nonce reused for another operation is not executed', async () => {
  const { db, gateway } = await setup();
  try {
    const c = call('payments.execute', S1, 'op-first');
    const control = await issue(db, c);
    const first = await gateway.execute(c, control);
    assert.equal(first.receipt.status, 'executed');
    assert.equal(await ledgerRows(db, 'op-first'), 1);

    const other = call('payments.execute', S1, 'op-second');
    const second = await gateway.execute(other, control);
    assert.equal(second.receipt.status, 'not_executed');
    assert.match(second.receipt.reason, /consum|operation|control/i);
    assert.equal(await ledgerRows(db, 'op-second'), 0);
  } finally { await db.close(); }
});

test('repeating the same operation_id returns the first receipt and writes no second ledger row', async () => {
  const { db, gateway } = await setup();
  try {
    const c = call('payments.execute', S1, 'op-repeat');
    const control = await issue(db, c);
    const first = await gateway.execute(c, control);
    const second = await gateway.execute(c, control);
    assert.equal(first.receipt.status, 'executed');
    assert.equal(second.receipt.receipt_id, first.receipt.receipt_id);
    assert.equal(await ledgerRows(db, 'op-repeat'), 1);
    const rec = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM execution_receipts WHERE operation_id = 'op-repeat'`);
    assert.equal(rec.rows[0].n, 1, 'a repeat must not write a second execution_receipts row');
  } finally { await db.close(); }
});

test('deny and hold actions are not executed', async () => {
  const { db, gateway } = await setup();
  try {
    const deny = await issue(db, call('payments.execute', S1, 'op-deny'), { action: 'deny' });
    const denyExec = await gateway.execute(call('payments.execute', S1, 'op-deny'), deny);
    assert.equal(denyExec.receipt.status, 'not_executed');
    assert.match(denyExec.receipt.reason, /deny|allow|control|action/i);
    assert.equal(await ledgerRows(db, 'op-deny'), 0);

    const hold = await issue(db, call('payments.execute', S1, 'op-hold'), { action: 'hold_for_review' });
    const holdExec = await gateway.execute(call('payments.execute', S1, 'op-hold'), hold);
    assert.equal(holdExec.receipt.status, 'not_executed');
    assert.match(holdExec.receipt.reason, /hold|allow|control|action/i);
    assert.equal(await ledgerRows(db, 'op-hold'), 0);
  } finally { await db.close(); }
});

test('read tools are unaffected by gate mode (no control required)', async () => {
  const { db, gateway } = await setup();
  try {
    const po = await gateway.execute(call('erp.get_po', { po_id: 'PO-4410' }, 'op-read'), null);
    assert.equal(po.receipt.status, 'executed');
    assert.equal(po.result.status, 'ok');
    assert.equal((po.result.body as { po: { vendor_id: string } }).po.vendor_id, 'V-118');
    const vendor = await gateway.execute(call('vendor.lookup', { vendor_id: 'V-118' }, 'op-vendor'), null);
    assert.equal(vendor.receipt.status, 'executed');
  } finally { await db.close(); }
});

test('a shadow gateway (no gate) executes without a control', async () => {
  const db = await openDb();
  await migrate(db);
  await seedSandbox(db, 't-alpha');
  try {
    const gateway = createToolGateway(db);
    const exec = await gateway.execute(call('payments.execute', S1, 'op-shadow'), null);
    assert.equal(exec.receipt.status, 'executed');
    assert.equal(await ledgerRows(db, 'op-shadow'), 1);
  } finally { await db.close(); }
});
