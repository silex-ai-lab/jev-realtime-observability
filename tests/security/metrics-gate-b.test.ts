import test from 'node:test';
import assert from 'node:assert/strict';
import { argsDigest, createToolGateway } from '../../sandbox/index.ts';
import { makeBoundaryEvent, postEventOk, startGateAHarness, waitFor } from '../helpers/harness.ts';

test('Gate B metrics: capture_coverage uses gateway_attempts as denominator', async () => {
  const h = await startGateAHarness({ judge: null, worker: { autostart: false, leaseMs: 30_000, realtimeTtlMs: 60_000 } });
  try {
    const gateway = createToolGateway(h.db);
    const runId = `run-${crypto.randomUUID()}`;

    const capturedArgs = { po_id: 'PO-4410' };
    const capturedOperationId = `op-${crypto.randomUUID()}`;
    await postEventOk(h, makeBoundaryEvent({
      run_id: runId,
      boundary: 'pre_tool',
      task_goal: 'Check PO-4410 before payment.',
      operation: { tool: 'erp.get_po', operation_id: capturedOperationId, args: capturedArgs, args_digest: argsDigest(capturedArgs) },
      sources: [],
    }));
    await gateway.execute({ tenantId: 't-alpha', runId, tool: 'erp.get_po', operationId: capturedOperationId, args: capturedArgs });

    const uncapturedOperationId = `op-${crypto.randomUUID()}`;
    await gateway.execute({ tenantId: 't-alpha', runId, tool: 'vendor.lookup', operationId: uncapturedOperationId, args: { vendor_id: 'V-118' } });

    const metrics = await waitFor(async () => {
      const { response, body } = await h.json<Record<string, unknown>>('GET', `/v1/metrics?run_id=${encodeURIComponent(runId)}`, {
        tenant: 'alpha',
        role: 'reader',
      });
      if (response.status !== 200) return null;
      const coverage = captureCoverage(body);
      return coverage.denominator >= 2 ? coverage : null;
    }, 'capture coverage metrics', 5_000);

    assert.equal(metrics.denominator, 2, 'denominator should include both gateway attempts');
    assert.equal(metrics.captured, 1, 'only the captured pre_tool operation should count as captured');
    assert.equal(metrics.value, 0.5);
  } finally {
    await h.close();
  }
});

interface CoverageParts {
  captured: number;
  denominator: number;
  value: number;
}

function captureCoverage(body: Record<string, unknown>): CoverageParts {
  const coverage = body.capture_coverage;
  assert.ok(coverage && typeof coverage === 'object' && !Array.isArray(coverage), `unexpected capture_coverage: ${JSON.stringify(coverage)}`);
  const record = coverage as Record<string, unknown>;
  const denominator = numberFrom(record.gateway_attempts) ?? numberFrom(record.denominator) ?? numberFrom(record.total);
  const captured = numberFrom(record.captured) ?? numberFrom(record.numerator);
  const value = numberFrom(record.value) ?? numberFrom(record.ratio);
  assert.equal(typeof denominator, 'number', `capture_coverage must expose gateway_attempts/denominator: ${JSON.stringify(record)}`);
  assert.equal(typeof captured, 'number', `capture_coverage must expose captured/numerator: ${JSON.stringify(record)}`);
  assert.equal(typeof value, 'number', `capture_coverage must expose value/ratio: ${JSON.stringify(record)}`);
  return { denominator: denominator as number, captured: captured as number, value: value as number };
}

function numberFrom(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
