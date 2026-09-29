// Tool gateway (RFC §3 tool gateway, §7.1 gate binding, plan §4). Executes tools for real against
// sandbox tables, idempotent by (tenant, operation_id), and returns an ExecutionReceipt per
// contracts/decision.ts. In shadow mode (no requireControl) it always executes; in gate mode it
// requires a bound ControlDecision for GATED_TOOLS only, loads it from control_decisions by id
// (never trusting a caller-supplied body), and re-verifies every binding + the authority state and
// consumes the nonce in the same transaction as the side effect.
import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from '../server/storage/db.ts';
import { digestOf } from '../contracts/canonical.ts';
import type { ControlDecision, ExecutionReceipt } from '../contracts/decision.ts';
import type { ToolCall, ToolExecution, ToolGateway, ToolGatewayOptions } from './index.ts';
import { TOOL_NAMES, dispatchTool, type ToolOutcome } from './tools/index.ts';
import { GATED_TOOLS, verifyControlInTx } from './control.ts';
import { appendOutbox } from '../server/storage/repos.ts';

/**
 * Pure structural binding + expiry check for a ControlDecision against a ToolCall (Gate A helper).
 * Gate C instead loads the authoritative control from control_decisions via createControlVerifier /
 * verifyControlInTx; this is kept for shadow-mode requireControl use and is never the gate path.
 */
export function verifyControlDecision(call: ToolCall, control: ControlDecision | null): { ok: boolean; reason: string } {
  if (!control) return { ok: false, reason: 'no ControlDecision bound to this call' };
  if (control.tenant_id !== call.tenantId) return { ok: false, reason: 'control tenant mismatch' };
  if (control.run_id !== call.runId) return { ok: false, reason: 'control run mismatch' };
  if (control.tool !== call.tool) return { ok: false, reason: 'control tool mismatch' };
  if (control.operation_id !== call.operationId) return { ok: false, reason: 'control operation mismatch' };
  if (control.args_digest !== digestOf(call.args)) return { ok: false, reason: 'control args digest mismatch' };
  if (Date.parse(control.expires_at) <= Date.now()) return { ok: false, reason: 'control expired' };
  return { ok: true, reason: 'ok' };
}

export function createToolGateway(db: Db, opts?: ToolGatewayOptions): ToolGateway {
  const gate = opts?.gate === true;
  const requireControl = opts?.requireControl;

  function buildReceipt(call: ToolCall, control: ControlDecision | null | undefined, argsDigest: string, outcome: ToolOutcome): ExecutionReceipt {
    return {
      receipt_id: `rcpt-${randomUUID()}`, tenant_id: call.tenantId, control_id: control?.control_id ?? null,
      operation_id: call.operationId, tool: call.tool, args_digest: argsDigest,
      status: outcome.refused ? 'failed' : 'executed',
      reason: outcome.refused ? `refused: ${String(outcome.body.error ?? 'unknown')}` : 'ok',
      resource_ref: outcome.resource_ref, at: new Date().toISOString(),
    };
  }

  const buildResult = (outcome: ToolOutcome): ToolExecution['result'] =>
    ({ status: outcome.ok ? 'ok' : 'error', http_status: outcome.http_status, body: outcome.body });

  /** Persists a completed side effect: idempotency cache + execution_receipts + outbox (§9.3). */
  async function persist(q: Queryable, call: ToolCall, receipt: ExecutionReceipt, result: ToolExecution['result']): Promise<void> {
    await q.query(
      `INSERT INTO sandbox.receipts (tenant_id, operation_id, receipt, result) VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id, operation_id) DO NOTHING`,
      [receipt.tenant_id, receipt.operation_id, JSON.stringify(receipt), JSON.stringify(result)],
    );
    await q.query(
      `INSERT INTO execution_receipts (tenant_id, receipt_id, operation_id, body) VALUES ($1, $2, $3, $4) ON CONFLICT (receipt_id) DO NOTHING`,
      [receipt.tenant_id, receipt.receipt_id, receipt.operation_id, JSON.stringify(receipt)],
    );
    await appendOutbox(q, { tenant_id: receipt.tenant_id, kind: 'receipt', ref_id: receipt.receipt_id, run_id: call.runId,
      payload: { receipt_id: receipt.receipt_id, operation_id: receipt.operation_id, run_id: call.runId, tool: receipt.tool,
        status: receipt.status, reason: receipt.reason, control_id: receipt.control_id } });
  }

  /**
   * Persists a `not_executed` receipt: execution_receipts + outbox only. It deliberately does NOT
   * touch sandbox.receipts (the idempotency cache), so a later retry of the same operation_id with a
   * fresh valid control can still execute — only completed side effects make a repeat return the
   * first receipt.
   */
  async function persistNotExecuted(q: Queryable, call: ToolCall, receipt: ExecutionReceipt, result: ToolExecution['result']): Promise<void> {
    await q.query(
      `INSERT INTO execution_receipts (tenant_id, receipt_id, operation_id, body) VALUES ($1, $2, $3, $4) ON CONFLICT (receipt_id) DO NOTHING`,
      [receipt.tenant_id, receipt.receipt_id, receipt.operation_id, JSON.stringify(receipt)],
    );
    await appendOutbox(q, { tenant_id: receipt.tenant_id, kind: 'receipt', ref_id: receipt.receipt_id, run_id: call.runId,
      payload: { receipt_id: receipt.receipt_id, operation_id: receipt.operation_id, run_id: call.runId, tool: receipt.tool,
        status: receipt.status, reason: receipt.reason, control_id: receipt.control_id } });
  }

  async function notExecuted(call: ToolCall, control: ControlDecision | null | undefined, argsDigest: string, reason: string): Promise<ToolExecution> {
    const receipt: ExecutionReceipt = {
      receipt_id: `rcpt-${randomUUID()}`, tenant_id: call.tenantId, control_id: control?.control_id ?? null,
      operation_id: call.operationId, tool: call.tool, args_digest: argsDigest,
      status: 'not_executed', reason, resource_ref: null, at: new Date().toISOString(),
    };
    const result: ToolExecution['result'] = { status: 'error', http_status: 403, body: { error: reason } };
    await persistNotExecuted(db, call, receipt, result);
    return { receipt, result };
  }

  async function execute(call: ToolCall, control?: ControlDecision | null): Promise<ToolExecution> {
    // Capture-coverage denominator (CONTRACTS §8.2): record the attempt before anything else,
    // whatever the outcome — executed, refused by tool authorization, or not_executed under a gate.
    await db.query(
      `INSERT INTO gateway_attempts (tenant_id, operation_id, run_id, tool) VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id, operation_id) DO NOTHING`,
      [call.tenantId, call.operationId, call.runId, call.tool],
    );
    const argsDigest = digestOf(call.args);
    const prior = await db.query<{ receipt: unknown; result: unknown }>(
      `SELECT receipt, result FROM sandbox.receipts WHERE tenant_id = $1 AND operation_id = $2`, [call.tenantId, call.operationId]);
    if (prior.rows[0]) {
      return { receipt: prior.rows[0].receipt as ExecutionReceipt, result: prior.rows[0].result as ToolExecution['result'] };
    }

    const gated = gate && (GATED_TOOLS as readonly string[]).includes(call.tool);
    if (gated) {
      // Cheap, lock-free pre-check (advisory only; fast-fail before opening a transaction).
      if (requireControl) {
        const pre = await requireControl(call, control ?? null);
        if (!pre.ok) return notExecuted(call, control, argsDigest, pre.reason);
      }
      // Test-only hook: runs after the outside pre-check and before the transaction opens, so a
      // revocation injected here can only be caught by the in-transaction check.
      if (opts?.onBeforeGateTx) await opts.onBeforeGateTx(call, control ?? null);
      // The deciding check: re-verify everything AND consume the nonce AND run the side effect in
      // one transaction. verifyControlInTx takes the control row FOR UPDATE and the authority rows
      // FOR SHARE, so a concurrent revocation either committed first (→ not_executed) or waits.
      const res = await db.tx(async q => {
        const verdict = await verifyControlInTx(q, call, control ?? null);
        if (!verdict.ok) return { reason: verdict.reason, receipt: null as ExecutionReceipt | null, result: null as ToolExecution['result'] | null };
        await q.query(`UPDATE control_decisions SET consumed_at = now() WHERE control_id = $1`, [control!.control_id]);
        const outcome = await dispatchTool(q, call);
        const receipt = buildReceipt(call, control, argsDigest, outcome);
        const result = buildResult(outcome);
        await persist(q, call, receipt, result);
        return { reason: null, receipt, result };
      });
      if (res.reason) return notExecuted(call, control, argsDigest, res.reason);
      return { receipt: res.receipt!, result: res.result! };
    }

    // Shadow-mode bare requireControl hook (no gate flag): verify then execute, no nonce consumption.
    // In gate mode this is not reached for gated tools (handled above), and read tools are never gated.
    if (!gate && requireControl) {
      const verdict = await requireControl(call, control ?? null);
      if (!verdict.ok) return notExecuted(call, control, argsDigest, verdict.reason);
    }

    const outcome = await dispatchTool(db, call);
    const receipt = buildReceipt(call, control, argsDigest, outcome);
    const result = buildResult(outcome);
    await persist(db, call, receipt, result);
    return { receipt, result };
  }

  return {
    execute,
    tools: () => [...TOOL_NAMES],
  };
}
