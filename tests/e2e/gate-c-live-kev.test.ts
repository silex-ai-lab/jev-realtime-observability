import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startGateAHarness,
  startSandboxRun,
  waitFor,
} from '../helpers/harness.ts';

const KEV_URL = process.env.KEV_URL;

test('Gate C live Kev gate mode executes S1 under allow and prevents S3', { skip: !KEV_URL ? 'set KEV_URL to run live Kev gate e2e' : false, timeout: 180_000 }, async () => {
  assert.ok(KEV_URL);
  const judge = {
    backend: 'kev-local' as const,
    baseUrl: KEV_URL,
    model: 'kev-latest',
    expectedRun: 'jaredpalmer/kev-0.8b',
    maxRps: 10,
    maxInputTokensPerSec: 1_000_000,
    maxResponseBytes: 1_000_000,
  };
  const h = await startGateAHarness({
    sourceMode: 'live_sandbox_gate',
    judge,
    gateJudge: judge,
    worker: { autostart: true, leaseMs: 30_000, realtimeTtlMs: 60_000 },
  });
  try {
    const s1 = await startSandboxRun(h, 'S1');
    await waitFor(async () => {
      const rows = await receiptsForRun(h, s1);
      return rows.some(r => r.tool === 'payments.execute' && r.status === 'executed' && r.control_id) ? rows : null;
    }, 'S1 executed payment under allow control', 45_000);
    assert.equal(await ledgerCountForRun(h, s1), 1, 'S1 payment should create one ledger row');

    const s3 = await startSandboxRun(h, 'S3');
    await waitFor(async () => {
      const rows = await receiptsForRun(h, s3);
      return rows.some(r => r.tool === 'payments.execute' && r.status === 'not_executed') ? rows : null;
    }, 'S3 denied payment receipt', 45_000);
    assert.equal(await ledgerCountForRun(h, s3), 0, 'S3 denied payment must not create a ledger row');

    const metrics = await waitFor(async () => {
      const { response, body } = await h.json<Record<string, unknown>>('GET', `/v1/metrics?run_id=${encodeURIComponent(s3)}`, {
        tenant: 'alpha',
        role: 'reader',
      });
      if (response.status !== 200) return null;
      const prevented = metricNumber(body.prevented);
      return prevented >= 1 ? prevented : null;
    }, 'S3 prevented metric', 15_000);
    assert.ok(metrics >= 1, `expected prevented count for S3, got ${metrics}`);
  } finally {
    await h.close();
  }
});

interface ReceiptRow {
  operation_id: string;
  tool: string;
  status: string;
  control_id: string | null;
  run_id: string;
}

async function receiptsForRun(h: Awaited<ReturnType<typeof startGateAHarness>>, runId: string): Promise<ReceiptRow[]> {
  const result = await h.db.query<{ operation_id: string; run_id: string; body: unknown }>(
    `SELECT r.operation_id, a.run_id, r.body
     FROM execution_receipts r
     JOIN gateway_attempts a ON a.tenant_id = r.tenant_id AND a.operation_id = r.operation_id
     WHERE r.tenant_id = $1 AND a.run_id = $2
     ORDER BY r.created_at, r.receipt_id`,
    ['t-alpha', runId],
  );
  const rows = result.rows
    .map(row => normalizeReceipt(row.operation_id, row.run_id, row.body))
    .filter((row): row is ReceiptRow => !!row);
  if (rows.length) return rows;

  const legacy = await h.db.query<{ operation_id: string; run_id: string; receipt: unknown }>(
    `SELECT r.operation_id, a.run_id, r.receipt
     FROM sandbox.receipts r
     JOIN gateway_attempts a ON a.tenant_id = r.tenant_id AND a.operation_id = r.operation_id
     WHERE r.tenant_id = $1 AND a.run_id = $2
     ORDER BY r.created_at, r.operation_id`,
    ['t-alpha', runId],
  );
  return legacy.rows
    .map(row => normalizeReceipt(row.operation_id, row.run_id, row.receipt))
    .filter((row): row is ReceiptRow => !!row);
}

function normalizeReceipt(operationId: string, runId: string, body: unknown): ReceiptRow | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const tool = typeof record.tool === 'string' ? record.tool : null;
  const status = typeof record.status === 'string' ? record.status : null;
  if (!tool || !status) return null;
  return {
    operation_id: typeof record.operation_id === 'string' ? record.operation_id : operationId,
    tool,
    status,
    control_id: typeof record.control_id === 'string' ? record.control_id : null,
    run_id: runId,
  };
}

async function ledgerCountForRun(h: Awaited<ReturnType<typeof startGateAHarness>>, runId: string): Promise<number> {
  const attempts = await h.db.query<{ operation_id: string }>(
    `SELECT operation_id FROM gateway_attempts WHERE tenant_id = $1 AND run_id = $2 AND tool = 'payments.execute'`,
    ['t-alpha', runId],
  );
  if (!attempts.rows.length) return 0;
  const result = await h.db.query<{ count: string | number }>(
    `SELECT count(*) AS count FROM sandbox.ledger WHERE tenant_id = $1 AND operation_id = ANY($2)`,
    ['t-alpha', attempts.rows.map(row => row.operation_id)],
  );
  return Number(result.rows[0]?.count ?? 0);
}

function metricNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ['count', 'value', 'total']) {
      const candidate = record[key];
      if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    }
  }
  return 0;
}
