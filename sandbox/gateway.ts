// Tool gateway (RFC §3 tool gateway, §7.1 gate binding, plan §4). Executes tools for real against
// sandbox tables, idempotent by (tenant, operation_id), and returns an ExecutionReceipt per
// contracts/decision.ts. In shadow mode (no requireControl) it always executes; in gate mode it
// requires a bound ControlDecision.
import { randomUUID } from 'node:crypto';
import type { Db } from '../server/storage/db.ts';
import { digestOf } from '../contracts/canonical.ts';
import type { ControlDecision, ExecutionReceipt } from '../contracts/decision.ts';
import type { ToolCall, ToolExecution, ToolGateway, ToolGatewayOptions } from './index.ts';
import { TOOL_NAMES, dispatchTool } from './tools/index.ts';

/**
 * Pure structural binding + expiry check for a ControlDecision against a ToolCall.
 * Revocation is tracked in the control_decisions table (Gate C) and is checked by the
 * requireControl callback supplied by the caller, not here.
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

    let receipt: ExecutionReceipt;
    let result: ToolExecution['result'];

    if (opts?.requireControl) {
      const verdict = await opts.requireControl(call, control ?? null);
      if (!verdict.ok) {
        receipt = {
          receipt_id: `rcpt-${randomUUID()}`, tenant_id: call.tenantId, control_id: control?.control_id ?? null,
          operation_id: call.operationId, tool: call.tool, args_digest: argsDigest,
          status: 'not_executed', reason: verdict.reason, resource_ref: null, at: new Date().toISOString(),
        };
        result = { status: 'error', http_status: 403, body: { error: verdict.reason } };
        await store(receipt, result);
        return { receipt, result };
      }
    }

    const outcome = await dispatchTool(db, call);
    receipt = {
      receipt_id: `rcpt-${randomUUID()}`, tenant_id: call.tenantId, control_id: control?.control_id ?? null,
      operation_id: call.operationId, tool: call.tool, args_digest: argsDigest,
      status: outcome.refused ? 'failed' : 'executed',
      reason: outcome.refused ? `refused: ${String(outcome.body.error ?? 'unknown')}` : 'ok',
      resource_ref: outcome.resource_ref, at: new Date().toISOString(),
    };
    result = { status: outcome.ok ? 'ok' : 'error', http_status: outcome.http_status, body: outcome.body };
    await store(receipt, result);
    return { receipt, result };
  }

  async function store(receipt: ExecutionReceipt, result: ToolExecution['result']): Promise<void> {
    await db.query(
      `INSERT INTO sandbox.receipts (tenant_id, operation_id, receipt, result) VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id, operation_id) DO NOTHING`,
      [receipt.tenant_id, receipt.operation_id, JSON.stringify(receipt), JSON.stringify(result)],
    );
  }

  return {
    execute,
    tools: () => [...TOOL_NAMES],
  };
}
