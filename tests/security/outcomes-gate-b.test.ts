import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutcomeVerifier } from '../../server/outcomes/index.ts';
import { argsDigest, createAuthorityReader, createToolGateway } from '../../sandbox/index.ts';
import {
  dumpDecisionPlane,
  makeBoundaryEvent,
  outcomeRowsForRun,
  postEventOk,
  runWorker,
  startGateAHarness,
  waitForDecision,
  waitForOutcomeState,
} from '../helpers/harness.ts';
import type { GateAHarness } from '../helpers/harness.ts';

const TENANT_ID = 't-alpha';
const VERIFIER_OPTIONS = { deadlineMs: { 'payments.execute': 10_000, 'email.send': 5_000 }, backoffMs: [250, 500, 1000, 2000] };

test('Gate B outcome: HTTP-200 pending payment is not verified_success and becomes unknown only after deadline', { timeout: 20_000 }, async () => {
  const h = await startGateAHarness({ judge: null, worker: { autostart: false, leaseMs: 30_000, realtimeTtlMs: 60_000 } });
  try {
    const executed = await executeTrackedPayment(h, s5PendingPayment());
    await runWorker(h);
    await waitForDecision(h, executed.runId);
    const before = await dumpDecisionPlane(h.db);

    const verifier = createOutcomeVerifier(h.db, createAuthorityReader(h.db), VERIFIER_OPTIONS);
    await h.db.tx(q => verifier.track(q, {
      tenantId: TENANT_ID,
      runId: executed.runId,
      eventId: executed.eventId,
      tool: 'payments.execute',
      operationId: executed.operationId,
      expected: paymentExpected(executed.args),
    }));

    await verifier.tick();
    let outcomes = await outcomeRowsForRun(h.db, TENANT_ID, executed.runId);
    assert.ok(outcomes.some(row => row.state === 'pending'), 'pending 200 receipt should be recorded as pending');
    assert.ok(!outcomes.some(row => row.state === 'verified_success'), 'HTTP 200 alone must not become verified_success');
    assert.ok(!outcomes.some(row => row.state === 'unknown_after_deadline'), 'pending must not become unknown before its deadline');

    await h.db.query(
      `UPDATE outcome_checks
       SET deadline_at = now() - interval '1 second', next_check_at = now() - interval '1 second'
       WHERE tenant_id = $1 AND operation_id = $2`,
      [TENANT_ID, executed.operationId],
    );
    await verifier.tick();
    outcomes = await outcomeRowsForRun(h.db, TENANT_ID, executed.runId);
    assert.ok(outcomes.some(row => row.state === 'unknown_after_deadline'), 'pending_forever should become unknown_after_deadline after deadline');
    assert.ok(!outcomes.some(row => row.state === 'verified_success'), 'pending_forever must never be promoted to verified_success');

    const after = await dumpDecisionPlane(h.db);
    assert.deepEqual(after, before, 'outcome verification must not rewrite snapshots, evaluations or decisions');
  } finally {
    await h.close();
  }
});

test('Gate B outcome: failed settlement becomes verified_failure', { timeout: 20_000 }, async () => {
  const h = await startGateAHarness({ judge: null, worker: { autostart: false, leaseMs: 30_000, realtimeTtlMs: 60_000 } });
  try {
    const executed = await executeTrackedPayment(h, s5FailedPayment());
    const verifier = createOutcomeVerifier(h.db, createAuthorityReader(h.db), VERIFIER_OPTIONS);
    await h.db.tx(q => verifier.track(q, {
      tenantId: TENANT_ID,
      runId: executed.runId,
      eventId: executed.eventId,
      tool: 'payments.execute',
      operationId: executed.operationId,
      expected: paymentExpected(executed.args),
    }));

    await waitFor(async () => {
      await h.db.query(
        `UPDATE outcome_checks SET next_check_at = now() - interval '1 second' WHERE tenant_id = $1 AND operation_id = $2`,
        [TENANT_ID, executed.operationId],
      );
      await verifier.tick();
      const rows = await outcomeRowsForRun(h.db, TENANT_ID, executed.runId);
      return rows.some(row => row.state === 'verified_failure') ? rows : null;
    }, 'verified_failure outcome', 5_000);
  } finally {
    await h.close();
  }
});

interface PaymentArgs {
  invoice_id: string;
  po_id: string;
  amount_usd: number;
  payee: string;
  account_ref: string;
  remit_domain: string;
}

interface ExecutedPayment {
  runId: string;
  eventId: string;
  operationId: string;
  args: PaymentArgs;
}

async function executeTrackedPayment(h: GateAHarness, args: PaymentArgs): Promise<ExecutedPayment> {
  const gateway = createToolGateway(h.db);
  const runId = `run-${crypto.randomUUID()}`;
  const operationId = `op-${crypto.randomUUID()}`;
  const wireArgs: Record<string, unknown> = { ...args };
  const execution = await gateway.execute({ tenantId: TENANT_ID, runId, tool: 'payments.execute', operationId, args: wireArgs });
  assert.equal(execution.result.http_status, 200, 'payment tool should return HTTP 200 even while settlement is pending');
  assert.equal(execution.receipt.status, 'executed');

  const event = makeBoundaryEvent({
    run_id: runId,
    event_id: `evt-${crypto.randomUUID()}`,
    producer_seq: 2,
    boundary: 'post_tool',
    task_goal: `Pay invoice ${args.invoice_id}.`,
    operation: { tool: 'payments.execute', operation_id: operationId, args: wireArgs, args_digest: argsDigest(wireArgs) },
    result: execution.result,
    sources: [],
  });
  await postEventOk(h, event);
  return { runId, eventId: event.event_id, operationId, args };
}

function paymentExpected(args: PaymentArgs): Record<string, string | number> {
  return { invoice_id: args.invoice_id, amount_usd: args.amount_usd, payee: args.payee };
}

function s5PendingPayment(): PaymentArgs {
  return {
    invoice_id: 'INV-8140',
    po_id: 'PO-4530',
    amount_usd: 6150,
    payee: 'Summit Janitorial LLC',
    account_ref: 'ACCT-422-01',
    remit_domain: 'bank.northwind.example',
  };
}

function s5FailedPayment(): PaymentArgs {
  return {
    invoice_id: 'INV-8175',
    po_id: 'PO-4561',
    amount_usd: 1800,
    payee: 'Summit Janitorial LLC',
    account_ref: 'ACCT-422-01',
    remit_domain: 'bank.northwind.example',
  };
}

async function waitFor<T>(fn: () => Promise<T | null>, label: string, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}
