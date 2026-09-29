// N1: the gate's row-lock guarantees (docs/GATE.md, CONTRACTS §9.2) on a real PostgreSQL. PGlite runs one
// connection, so these races can only happen here. Skipped unless TEST_DATABASE_URL is set, e.g.
//   TEST_DATABASE_URL=postgres://127.0.0.1:5432/jev_test node --test tests/integration/gate-postgres.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { argsDigest, createToolGateway } from '../../sandbox/index.ts';
import { createControlVerifier } from '../../sandbox/control.ts';
import type { ToolCall } from '../../sandbox/index.ts';
import type { PreflightResponse } from '../../contracts/preflight.ts';
import { SCHEMA_VERSION } from '../../contracts/common.ts';
import { openDb } from '../../server/storage/db.ts';
import { startGateAHarness, startStubJudge, type GateAHarness } from '../helpers/harness.ts';

const TENANT_ID = 't-alpha';
const skip = !process.env.TEST_DATABASE_URL;

async function startGateCPostgres(judgeUrl: string): Promise<GateAHarness> {
  const judge = { backend: 'stub' as const, baseUrl: judgeUrl, model: 'kev-latest', expectedRun: 'stub', maxRps: 100, maxInputTokensPerSec: 1_000_000, maxResponseBytes: 1_000_000 };
  const db = await openDb({ url: process.env.TEST_DATABASE_URL! });
  return startGateAHarness({ db, sourceMode: 'live_sandbox_gate', judge, gateJudge: judge, worker: { autostart: false, leaseMs: 30_000, realtimeTtlMs: 60_000 } });
}

// A fresh invoice per call would need seeding; S1's payment is allowed each time because every test uses a new
// operation_id and the sandbox ledger is keyed by operation.
const payment = () => ({ invoice_id: 'INV-7731', po_id: 'PO-4410', amount_usd: 8420, payee: 'Pacific Paper Co.', account_ref: 'ACCT-118-01', remit_domain: 'bank.northwind.example' });

async function issueAllow(h: GateAHarness, runId: string, operationId: string): Promise<PreflightResponse> {
  const args = payment();
  const r = await h.request('POST', '/v1/preflight', { tenant: 'alpha', role: 'ingest', body: {
    schema_version: SCHEMA_VERSION, event_id: `evt-${crypto.randomUUID()}`, run_id: runId, trace_id: '0123456789abcdef0123456789abcdef',
    producer_id: 'gate-pg-test', producer_seq: 1, actor: { kind: 'agent', id: 'agent-ap' },
    operation: { tool: 'payments.execute', operation_id: operationId, args, args_digest: argsDigest(args) }, sources: [] } });
  const text = await r.text();
  assert.equal(r.status, 200, text);
  const out = JSON.parse(text) as PreflightResponse;
  assert.equal(out.control.action, 'allow', text);
  return out;
}

async function ledgerCount(h: GateAHarness, operationId: string): Promise<number> {
  const r = await h.db.query<{ n: string }>(`SELECT count(*) AS n FROM sandbox.ledger WHERE tenant_id = $1 AND operation_id = $2`, [TENANT_ID, operationId]);
  return Number(r.rows[0].n);
}

test('real-Postgres gate: two concurrent consumes of one control execute exactly once', { skip }, async () => {
  const judge = await startStubJudge();
  const h = await startGateCPostgres(judge.url);
  try {
    const runId = `run-gpg-${crypto.randomUUID()}`, operationId = `op-${crypto.randomUUID()}`;
    const issued = await issueAllow(h, runId, operationId);
    // Both calls pass the lock-free pre-check, then wait for each other, so both open the deciding transaction together.
    let arrived = 0, release!: () => void;
    const barrier = new Promise<void>(r => { release = r; });
    const gateway = createToolGateway(h.db, { gate: true, requireControl: createControlVerifier(h.db),
      onBeforeGateTx: async () => { if (++arrived === 2) release(); await barrier; } });
    const call: ToolCall = { tenantId: TENANT_ID, runId, tool: 'payments.execute', operationId, args: payment() };
    const [a, b] = await Promise.all([gateway.execute(call, issued.control), gateway.execute(call, issued.control)]);
    assert.equal(arrived, 2, 'both calls reached the transaction');
    assert.deepEqual([a.receipt.status, b.receipt.status].sort(), ['executed', 'not_executed'], JSON.stringify([a.receipt, b.receipt]));
    assert.match([a, b].find(x => x.receipt.status === 'not_executed')!.receipt.reason, /consum/i);
    assert.equal(await ledgerCount(h, operationId), 1);
  } finally { await h.close(); await judge.close(); }
});

test('real-Postgres gate: a revocation racing a consume never lets it execute after the revoke', { skip }, async () => {
  const judge = await startStubJudge();
  const h = await startGateCPostgres(judge.url);
  try {
    // (a) The revoke holds the control row, uncommitted, while the consume starts: the consume must wait on
    //     the row lock and, once the revoke commits, refuse.
    {
      const runId = `run-gpg-${crypto.randomUUID()}`, operationId = `op-${crypto.randomUUID()}`;
      const issued = await issueAllow(h, runId, operationId);
      let commitRevoke!: () => void, locked!: () => void;
      const hold = new Promise<void>(r => { commitRevoke = r; }), isLocked = new Promise<void>(r => { locked = r; });
      const revoke = h.db.tx(async q => {
        await q.query(`UPDATE control_decisions SET revoked_at = now() WHERE tenant_id = $1 AND control_id = $2`, [TENANT_ID, issued.control.control_id]);
        locked(); await hold;
      });
      await isLocked;
      let finished = false;
      const gateway = createToolGateway(h.db, { gate: true });   // no lock-free pre-check: only the transaction decides
      const exec = gateway.execute({ tenantId: TENANT_ID, runId, tool: 'payments.execute', operationId, args: payment() }, issued.control)
        .then(x => { finished = true; return x; });
      await new Promise(r => setTimeout(r, 300));
      assert.equal(finished, false, 'the consume waits for the revoking transaction');
      commitRevoke(); await revoke;
      const out = await exec;
      assert.equal(out.receipt.status, 'not_executed');
      assert.match(out.receipt.reason, /revok/i);
      assert.equal(await ledgerCount(h, operationId), 0);
    }
    // (b) Free races through the API, 20 rounds: whichever commits first wins, and an executed call was always
    //     consumed before (never after) its revocation.
    for (let i = 0; i < 20; i++) {
      const runId = `run-gpg-${crypto.randomUUID()}`, operationId = `op-${crypto.randomUUID()}`;
      const issued = await issueAllow(h, runId, operationId);
      const gateway = createToolGateway(h.db, { gate: true });
      const [out, rev] = await Promise.all([
        gateway.execute({ tenantId: TENANT_ID, runId, tool: 'payments.execute', operationId, args: payment() }, issued.control),
        h.request('POST', `/v1/controls/${encodeURIComponent(issued.control.control_id)}/revoke`, { tenant: 'alpha', role: 'admin', body: {} }),
      ]);
      assert.equal(rev.status, 200, await rev.text());
      const row = (await h.db.query<{ consumed_at: Date | null; revoked_at: Date | null }>(
        `SELECT consumed_at, revoked_at FROM control_decisions WHERE control_id = $1`, [issued.control.control_id])).rows[0];
      if (out.receipt.status === 'executed') {
        assert.ok(row.consumed_at && row.revoked_at && row.consumed_at.getTime() <= row.revoked_at.getTime(), `round ${i}: executed after revoke ${JSON.stringify(row)}`);
        assert.equal(await ledgerCount(h, operationId), 1);
      } else {
        assert.equal(out.receipt.status, 'not_executed');
        assert.equal(row.consumed_at, null, `round ${i}: a refused call never consumes`);
        assert.equal(await ledgerCount(h, operationId), 0);
      }
    }
  } finally { await h.close(); await judge.close(); }
});
