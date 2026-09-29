import test from 'node:test';
import assert from 'node:assert/strict';
import { argsDigest, createToolGateway } from '../../sandbox/index.ts';
import { createControlVerifier, revokeApproval } from '../../sandbox/control.ts';
import { GATE_BUDGET, type PreflightRequest, type PreflightResponse } from '../../contracts/preflight.ts';
import type { ExecutionReceipt } from '../../contracts/decision.ts';
import { SCHEMA_VERSION } from '../../contracts/common.ts';
import { CANARY_JUDGE_API_KEY, assertNoCanary } from '../helpers/canary.ts';
import {
  collectStream,
  dumpAllTables,
  startGateAHarness,
  startStubJudge,
} from '../helpers/harness.ts';
import type { GateAHarness } from '../helpers/harness.ts';

const TENANT_ID = 't-alpha';
const TRACE_ID = '0123456789abcdef0123456789abcdef';

test('Gate C preflight: check-A-execute-B with changed args is not executed', async () => {
  const judge = await startStubJudge();
  const h = await startGateCHarness(judge.url);
  try {
    const runId = `run-gc-${crypto.randomUUID()}`;
    const operationId = `op-${crypto.randomUUID()}`;
    const args = s1Payment();
    const issued = await preflightOk(h, { runId, operationId, args });
    assert.equal(issued.control.action, 'allow');

    const changed = { ...args, amount_usd: 8421 };
    const execution = await gatedGateway(h).execute(
      { tenantId: TENANT_ID, runId, tool: 'payments.execute', operationId, args: changed },
      issued.control,
    );
    assertNotExecuted(execution.receipt, /args|digest|bind/i);
    assert.equal(await ledgerCount(h, operationId), 0, 'changed args must not create a ledger row');
  } finally {
    await h.close();
    await judge.close();
  }
});

test('Gate C preflight: expired control is not executed', async () => {
  const judge = await startStubJudge();
  const h = await startGateCHarness(judge.url);
  try {
    const runId = `run-gc-${crypto.randomUUID()}`;
    const operationId = `op-${crypto.randomUUID()}`;
    const issued = await preflightOk(h, { runId, operationId, args: s1Payment() });
    await expireControl(h, issued.control.control_id);

    const execution = await gatedGateway(h).execute(
      { tenantId: TENANT_ID, runId, tool: 'payments.execute', operationId, args: s1Payment() },
      issued.control,
    );
    assertNotExecuted(execution.receipt, /expir/i);
    assert.equal(await ledgerCount(h, operationId), 0);
  } finally {
    await h.close();
    await judge.close();
  }
});

test('Gate C preflight: consumed nonce cannot authorize a second operation', async () => {
  const judge = await startStubJudge();
  const h = await startGateCHarness(judge.url);
  try {
    const runId = `run-gc-${crypto.randomUUID()}`;
    const operationId = `op-${crypto.randomUUID()}`;
    const args = s1Payment();
    const issued = await preflightOk(h, { runId, operationId, args });
    const gateway = gatedGateway(h);

    const first = await gateway.execute({ tenantId: TENANT_ID, runId, tool: 'payments.execute', operationId, args }, issued.control);
    assert.equal(first.receipt.status, 'executed');
    assert.equal(await ledgerCount(h, operationId), 1);

    const secondOperationId = `op-${crypto.randomUUID()}`;
    const second = await gateway.execute({ tenantId: TENANT_ID, runId, tool: 'payments.execute', operationId: secondOperationId, args }, issued.control);
    assertNotExecuted(second.receipt, /consum|operation|control/i);
    assert.equal(await ledgerCount(h, secondOperationId), 0);
  } finally {
    await h.close();
    await judge.close();
  }
});

test('Gate C preflight: authority revoked after issue prevents execution and names the authority change', async () => {
  const judge = await startStubJudge();
  const h = await startGateCHarness(judge.url);
  try {
    const runId = `run-gc-${crypto.randomUUID()}`;
    const operationId = `op-${crypto.randomUUID()}`;
    const issued = await preflightOk(h, { runId, operationId, args: s1Payment() });
    await revokeApproval(h.db, TENANT_ID, 'APR-2291');

    const execution = await gatedGateway(h).execute(
      { tenantId: TENANT_ID, runId, tool: 'payments.execute', operationId, args: s1Payment() },
      issued.control,
    );
    assertNotExecuted(execution.receipt, /authori|version|approval|changed|revok/i);
    assert.equal(await ledgerCount(h, operationId), 0);
  } finally {
    await h.close();
    await judge.close();
  }
});

test('Gate C controls: API revocation prevents execution', async () => {
  const judge = await startStubJudge();
  const h = await startGateCHarness(judge.url);
  try {
    const runId = `run-gc-${crypto.randomUUID()}`;
    const operationId = `op-${crypto.randomUUID()}`;
    const issued = await preflightOk(h, { runId, operationId, args: s1Payment() });

    const revoke = await h.request('POST', `/v1/controls/${encodeURIComponent(issued.control.control_id)}/revoke`, {
      tenant: 'alpha',
      role: 'admin',
      body: {},
    });
    const revokeText = await revoke.text();
    assert.ok(revoke.status === 200 || revoke.status === 204, revokeText);

    const execution = await gatedGateway(h).execute(
      { tenantId: TENANT_ID, runId, tool: 'payments.execute', operationId, args: s1Payment() },
      issued.control,
    );
    assertNotExecuted(execution.receipt, /revok/i);
    assert.equal(await ledgerCount(h, operationId), 0);
  } finally {
    await h.close();
    await judge.close();
  }
});

test('Gate C preflight: deny and hold controls never execute in the gateway', async () => {
  const judge = await startStubJudge();
  const h = await startGateCHarness(judge.url);
  try {
    const deniedRunId = `run-gc-${crypto.randomUUID()}`;
    const deniedOperationId = `op-${crypto.randomUUID()}`;
    const denied = await preflightOk(h, { runId: deniedRunId, operationId: deniedOperationId, args: s3OverLimitPayment() });
    assert.equal(denied.control.action, 'deny');
    const deniedExecution = await gatedGateway(h).execute(
      { tenantId: TENANT_ID, runId: deniedRunId, tool: 'payments.execute', operationId: deniedOperationId, args: s3OverLimitPayment() },
      denied.control,
    );
    assertNotExecuted(deniedExecution.receipt, /deny|allow|control|action/i);
    assert.equal(await ledgerCount(h, deniedOperationId), 0);

    const heldRunId = `run-gc-${crypto.randomUUID()}`;
    const heldOperationId = `op-${crypto.randomUUID()}`;
    const held = await preflightOk(h, { runId: heldRunId, operationId: heldOperationId, args: s4MissingApprovalPayment() });
    assert.equal(held.control.action, 'hold_for_approval');
    const heldExecution = await gatedGateway(h).execute(
      { tenantId: TENANT_ID, runId: heldRunId, tool: 'payments.execute', operationId: heldOperationId, args: s4MissingApprovalPayment() },
      held.control,
    );
    assertNotExecuted(heldExecution.receipt, /hold|allow|control|action/i);
    assert.equal(await ledgerCount(h, heldOperationId), 0);
  } finally {
    await h.close();
    await judge.close();
  }
});

test('Gate C preflight: judge timeout holds review within the synchronous budget and writes no ledger row', { timeout: 10_000 }, async () => {
  const judge = await startStubJudge({ respond: () => ({ status: 200, body: { model: 'kev-latest', answers: {} }, delayMs: 10_000 }) });
  const h = await startGateCHarness(judge.url);
  try {
    const runId = `run-gc-${crypto.randomUUID()}`;
    const operationId = `op-${crypto.randomUUID()}`;
    const started = performance.now();
    const issued = await preflightOk(h, { runId, operationId, args: s1Payment() });
    const elapsed = performance.now() - started;

    assert.equal(issued.control.action, 'hold_for_review');
    assert.equal(issued.decision.decided_by, 'judge_unavailable');
    assert.ok(issued.timings.total_ms <= GATE_BUDGET.totalMs + 150, `reported total_ms exceeded budget + slack: ${issued.timings.total_ms}`);
    assert.ok(elapsed <= GATE_BUDGET.totalMs + 500, `wall time exceeded budget + slack: ${elapsed}`);
    assert.equal(await ledgerCount(h, operationId), 0);
  } finally {
    await h.close();
    await judge.close();
  }
});

test('Gate C preflight: total_ms is measured and the canary judge key never leaks', async () => {
  const captured: string[] = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.error = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
  console.warn = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
  console.log = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };

  const judge = await startStubJudge();
  const h = await startGateCHarness(judge.url, CANARY_JUDGE_API_KEY);
  try {
    const runId = `run-gc-${crypto.randomUUID()}`;
    const operationId = `op-${crypto.randomUUID()}`;
    const request = makePreflightRequest({ runId, operationId, args: s1Payment() });
    assertNoCanary(request, 'preflight request');

    const response = await h.request('POST', '/v1/preflight', { tenant: 'alpha', role: 'ingest', body: request });
    const text = await response.text();
    assertNoCanary(text, 'preflight HTTP response');
    assert.equal(response.status, 200, text);
    const body = JSON.parse(text) as PreflightResponse;
    assert.equal(typeof body.timings.total_ms, 'number');
    assert.ok(body.timings.total_ms >= 0);

    assertNoCanary(await collectStream(h, 'alpha'), 'SSE payload');
    assertNoCanary(await dumpAllTables(h.db), 'database dump');
    assertNoCanary(captured.join('\n'), 'console output');
  } finally {
    await h.close();
    await judge.close();
    console.error = originalError;
    console.warn = originalWarn;
    console.log = originalLog;
  }
});

test('Gate C preflight: replaying an executed allow operation never creates a second ledger row', async () => {
  const judge = await startStubJudge();
  const h = await startGateCHarness(judge.url);
  try {
    const runId = `run-gc-${crypto.randomUUID()}`;
    const operationId = `op-${crypto.randomUUID()}`;
    const args = s1Payment();
    const issued = await preflightOk(h, { runId, operationId, args });
    assert.equal(issued.control.action, 'allow');
    const gateway = gatedGateway(h);

    const first = await gateway.execute({ tenantId: TENANT_ID, runId, tool: 'payments.execute', operationId, args }, issued.control);
    const second = await gateway.execute({ tenantId: TENANT_ID, runId, tool: 'payments.execute', operationId, args }, issued.control);

    assert.equal(first.receipt.status, 'executed');
    assert.deepEqual(second.receipt, first.receipt, 'idempotent replay should return the first receipt');
    assert.equal(await ledgerCount(h, operationId), 1);
  } finally {
    await h.close();
    await judge.close();
  }
});

interface PaymentArgs extends Record<string, unknown> {
  invoice_id: string;
  po_id: string;
  amount_usd: number;
  payee: string;
  account_ref: string;
  remit_domain: string;
}

interface PreflightInput {
  runId: string;
  operationId: string;
  args: PaymentArgs;
  tool?: string;
}

async function startGateCHarness(judgeUrl: string, apiKey?: string): Promise<GateAHarness> {
  return startGateAHarness({
    sourceMode: 'live_sandbox_gate',
    judge: {
      backend: 'stub',
      baseUrl: judgeUrl,
      apiKey,
      model: 'kev-latest',
      expectedRun: 'stub',
      maxRps: 100,
      maxInputTokensPerSec: 1_000_000,
      maxResponseBytes: 1_000_000,
    },
    gateJudge: {
      backend: 'stub',
      baseUrl: judgeUrl,
      apiKey,
      model: 'kev-latest',
      expectedRun: 'stub',
      maxRps: 100,
      maxInputTokensPerSec: 1_000_000,
      maxResponseBytes: 1_000_000,
    },
    worker: { autostart: false, leaseMs: 30_000, realtimeTtlMs: 60_000 },
  });
}

async function preflightOk(h: GateAHarness, input: PreflightInput): Promise<PreflightResponse> {
  const response = await h.request('POST', '/v1/preflight', {
    tenant: 'alpha',
    role: 'ingest',
    body: makePreflightRequest(input),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text) as PreflightResponse;
}

function makePreflightRequest(input: PreflightInput): PreflightRequest {
  return {
    schema_version: SCHEMA_VERSION,
    event_id: `evt-${crypto.randomUUID()}`,
    run_id: input.runId,
    trace_id: TRACE_ID,
    producer_id: 'gate-c-test-wrapper',
    producer_seq: 1,
    actor: { kind: 'agent', id: 'agent-ap' },
    operation: {
      tool: input.tool ?? 'payments.execute',
      operation_id: input.operationId,
      args: input.args,
      args_digest: argsDigest(input.args),
    },
    sources: [],
  };
}

function gatedGateway(h: GateAHarness) {
  return createToolGateway(h.db, { requireControl: createControlVerifier(h.db) });
}

function assertNotExecuted(receipt: ExecutionReceipt, reasonPattern: RegExp): void {
  assert.equal(receipt.status, 'not_executed');
  assert.match(receipt.reason, reasonPattern);
}

async function expireControl(h: GateAHarness, controlId: string): Promise<void> {
  await h.db.query(
    `UPDATE control_decisions
     SET body = body || jsonb_build_object('expires_at', $2::text)
     WHERE control_id = $1`,
    [controlId, new Date(Date.now() - 1_000).toISOString()],
  );
}

async function ledgerCount(h: GateAHarness, operationId: string): Promise<number> {
  const result = await h.db.query<{ count: string | number }>(
    `SELECT count(*) AS count FROM sandbox.ledger WHERE tenant_id = $1 AND operation_id = $2`,
    [TENANT_ID, operationId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

function s1Payment(): PaymentArgs {
  return {
    invoice_id: 'INV-7731',
    po_id: 'PO-4410',
    amount_usd: 8420,
    payee: 'Pacific Paper Co.',
    account_ref: 'ACCT-118-01',
    remit_domain: 'bank.northwind.example',
  };
}

function s3OverLimitPayment(): PaymentArgs {
  return {
    invoice_id: 'INV-8120',
    po_id: 'PO-4502',
    amount_usd: 48000,
    payee: 'Cascade Hardware Inc.',
    account_ref: 'ACCT-311-02',
    remit_domain: 'bank.northwind.example',
  };
}

function s4MissingApprovalPayment(): PaymentArgs {
  return {
    invoice_id: 'INV-8133',
    po_id: 'PO-4519',
    amount_usd: 9800,
    payee: 'Pacific Paper Co.',
    account_ref: 'ACCT-118-01',
    remit_domain: 'bank.northwind.example',
  };
}
