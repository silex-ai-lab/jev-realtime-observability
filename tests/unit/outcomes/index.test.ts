// Outcome verifier state machine (docs/CONTRACTS.md §8.3): pending → verified_success / mismatch /
// verified_failure / unknown_after_deadline, decided only by the authoritative read-back, appended to
// outcomes + outbox, and never touching events, snapshots, evaluations or decisions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, type Queryable } from '../../../server/storage/db.ts';
import { seedSandbox, createAuthorityReader, createToolGateway } from '../../../sandbox/index.ts';
import { createOutcomeVerifier, OUTCOME_TOOLS } from '../../../server/outcomes/index.ts';
import type { ToolCall } from '../../../sandbox/index.ts';

const call = (tool: string, args: Record<string, unknown>, operationId: string): ToolCall =>
  ({ tenantId: 't-alpha', runId: 'run-1', tool, operationId, args });

async function setup() {
  const db = await openDb();
  await migrate(db);
  await seedSandbox(db, 't-alpha');
  const authority = createAuthorityReader(db);
  const gateway = createToolGateway(db);
  const verifier = createOutcomeVerifier(db, authority, { deadlineMs: { 'payments.execute': 10_000, 'email.send': 5_000 }, backoffMs: [250, 500, 1000, 2000] });
  return { db, authority, gateway, verifier };
}

const S1 = { invoice_id: 'INV-7731', po_id: 'PO-4410', amount_usd: 8420, payee: 'Pacific Paper Co.', account_ref: 'ACCT-118-01', remit_domain: 'bank.northwind.example' };

const due = async (db: Queryable, op: string) => {
  await db.query(`UPDATE outcome_checks SET next_check_at = now() - interval '1 second' WHERE tenant_id = 't-alpha' AND operation_id = $1`, [op]);
};

const checkState = async (db: Queryable, op: string) =>
  (await db.query<{ state: string }>(`SELECT state FROM outcome_checks WHERE tenant_id = 't-alpha' AND operation_id = $1`, [op])).rows[0]?.state;

test('pending → verified_success when the ledger posts the expected payee and amount', async () => {
  const { db, verifier, gateway } = await setup();
  try {
    await gateway.execute(call('payments.execute', S1, 'op-ok'));
    await verifier.track(db, { tenantId: 't-alpha', runId: 'run-1', eventId: 'ev-1', tool: 'payments.execute', operationId: 'op-ok', expected: { invoice_id: 'INV-7731', amount_usd: 8420, payee: 'Pacific Paper Co.' } });
    assert.equal(await checkState(db, 'op-ok'), 'pending');
    await due(db, 'op-ok');
    const n = await verifier.tick();
    assert.equal(n, 1);
    assert.equal(await checkState(db, 'op-ok'), 'verified_success');
    const out = await db.query<{ kind: string; payload: unknown }>(`SELECT kind, payload FROM outbox WHERE tenant_id = 't-alpha' AND kind = 'outcome' ORDER BY cursor ASC`);
    assert.deepEqual(out.rows.map(r => (r.payload as { state: string }).state), ['pending', 'verified_success']);
  } finally { await db.close(); }
});

test('track records the initial pending observation in the outcomes history', async () => {
  const { db, verifier, gateway } = await setup();
  try {
    await gateway.execute(call('payments.execute',
      { invoice_id: 'INV-8140', po_id: 'PO-4530', amount_usd: 6150, payee: 'Summit Janitorial LLC', account_ref: 'ACCT-422-01' }, 'op-pen'));
    await verifier.track(db, { tenantId: 't-alpha', runId: 'run-1', eventId: 'ev-p', tool: 'payments.execute', operationId: 'op-pen', expected: { invoice_id: 'INV-8140', amount_usd: 6150, payee: 'Summit Janitorial LLC' } });
    const rows = await db.query<{ state: string }>(`SELECT state FROM outcomes WHERE tenant_id = 't-alpha' AND operation_id = 'op-pen' ORDER BY created_at ASC`);
    assert.deepEqual(rows.rows.map(r => r.state), ['pending']);
  } finally { await db.close(); }
});

test('pending → mismatch when the ledger posts but the payee differs from the claim', async () => {
  const { db, verifier, gateway } = await setup();
  try {
    await gateway.execute(call('payments.execute', S1, 'op-m'));
    await verifier.track(db, { tenantId: 't-alpha', runId: 'run-1', eventId: 'ev-2', tool: 'payments.execute', operationId: 'op-m', expected: { invoice_id: 'INV-7731', amount_usd: 8420, payee: 'Someone Else LLC' } });
    await due(db, 'op-m');
    await verifier.tick();
    assert.equal(await checkState(db, 'op-m'), 'mismatch');
  } finally { await db.close(); }
});

test('pending → verified_failure when the ledger fails after the delay', async () => {
  const { db, verifier, gateway } = await setup();
  try {
    await gateway.execute(call('payments.execute',
      { invoice_id: 'INV-8175', po_id: 'PO-4561', amount_usd: 1800, payee: 'Summit Janitorial LLC', account_ref: 'ACCT-422-01' }, 'op-fail'));
    await db.query(`UPDATE sandbox.ledger SET created_at = now() - interval '2 seconds' WHERE operation_id = 'op-fail'`);
    await verifier.track(db, { tenantId: 't-alpha', runId: 'run-1', eventId: 'ev-3', tool: 'payments.execute', operationId: 'op-fail', expected: { invoice_id: 'INV-8175', amount_usd: 1800, payee: 'Summit Janitorial LLC' } });
    await due(db, 'op-fail');
    await verifier.tick();
    assert.equal(await checkState(db, 'op-fail'), 'verified_failure');
  } finally { await db.close(); }
});

test('pending → unknown_after_deadline when the ledger never settles before the deadline', async () => {
  const { db, verifier, gateway } = await setup();
  try {
    await gateway.execute(call('payments.execute',
      { invoice_id: 'INV-8140', po_id: 'PO-4530', amount_usd: 6150, payee: 'Summit Janitorial LLC', account_ref: 'ACCT-422-01' }, 'op-forever'));
    await verifier.track(db, { tenantId: 't-alpha', runId: 'run-1', eventId: 'ev-4', tool: 'payments.execute', operationId: 'op-forever', expected: { invoice_id: 'INV-8140', amount_usd: 6150, payee: 'Summit Janitorial LLC' } });
    await db.query(`UPDATE outcome_checks SET next_check_at = now() - interval '1 second', deadline_at = now() - interval '1 second' WHERE operation_id = 'op-forever'`);
    await verifier.tick();
    assert.equal(await checkState(db, 'op-forever'), 'unknown_after_deadline');
  } finally { await db.close(); }
});

test('the verifier never modifies events, snapshots, evaluations or decisions', async () => {
  const { db, verifier, gateway } = await setup();
  try {
    await gateway.execute(call('payments.execute', S1, 'op-x'));
    await verifier.track(db, { tenantId: 't-alpha', runId: 'run-1', eventId: 'ev-x', tool: 'payments.execute', operationId: 'op-x', expected: { invoice_id: 'INV-7731', amount_usd: 8420, payee: 'Pacific Paper Co.' } });
    await due(db, 'op-x');
    await verifier.tick();
    for (const t of ['events', 'snapshots', 'evaluations', 'decisions']) {
      const c = await db.query<{ n: number }>(`SELECT count(*)::int n FROM ${t}`);
      assert.equal(c.rows[0].n, 0, `${t} must be untouched`);
    }
  } finally { await db.close(); }
});

test('track is idempotent per (tenant, operation) and ignores non-side-effect tools', async () => {
  const { db, verifier } = await setup();
  try {
    await verifier.track(db, { tenantId: 't-alpha', runId: 'run-1', eventId: 'ev-a', tool: 'erp.get_po', operationId: 'op-read', expected: {} });
    await verifier.track(db, { tenantId: 't-alpha', runId: 'run-1', eventId: 'ev-b', tool: 'payments.execute', operationId: 'op-p', expected: { invoice_id: 'INV-7731', amount_usd: 8420, payee: 'Pacific Paper Co.' } });
    await verifier.track(db, { tenantId: 't-alpha', runId: 'run-1', eventId: 'ev-b2', tool: 'payments.execute', operationId: 'op-p', expected: { invoice_id: 'INV-7731', amount_usd: 8420, payee: 'Pacific Paper Co.' } });
    const c = await db.query<{ n: number }>(`SELECT count(*)::int n FROM outcome_checks WHERE tenant_id = 't-alpha'`);
    assert.equal(c.rows[0].n, 1, 'read tool skipped, duplicate payment check deduped');
    const h = await db.query<{ n: number }>(`SELECT count(*)::int n FROM outcomes WHERE tenant_id = 't-alpha' AND operation_id = 'op-p'`);
    assert.equal(h.rows[0].n, 1, 'a duplicate track must not append a second pending observation');
  } finally { await db.close(); }
});

test('OUTCOME_TOOLS is exactly the two executed side-effect tools', () => {
  assert.deepEqual([...OUTCOME_TOOLS], ['payments.execute', 'email.send']);
});
