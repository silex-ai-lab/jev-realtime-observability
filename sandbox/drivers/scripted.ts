// scripted_driver (RFC §4): runs a fixed step list against the real sandbox tool gateway and
// captures every boundary. In shadow mode it never waits for, or reads, a decision.
import { randomUUID } from 'node:crypto';
import { createCapture } from '../../sdk/index.ts';
import type { AuthorityReader, ToolGateway } from '../index.ts';
import type { Scenario } from '../scenarios/index.ts';

export interface DriverDeps {
  baseUrl: string;
  ingestKey: string;
  tenantId: string;
  gateway: ToolGateway;
  authority: AuthorityReader;
  mirrorOtlp: boolean;
}

export async function runScripted(d: DriverDeps, sc: Scenario, runId = `run-${sc.id.toLowerCase()}-${randomUUID().slice(0, 8)}`): Promise<{ run_id: string; errors: string[] }> {
  const cap = createCapture({ baseUrl: d.baseUrl, apiKey: d.ingestKey, producerId: 'scripted-driver', runId, mirrorOtlp: d.mirrorOtlp });
  const errors: string[] = [];
  const faultAttrs: Record<string, string> = sc.fault ? { fault: sc.fault } : {};
  try {
    const goal = sc.steps.find(s => s.kind === 'task');
    await cap.emit('run_started', { actor: { kind: 'user', id: 'finance-user' }, task_goal: goal?.kind === 'task' ? goal.goal : undefined,
      attributes: { driver: 'scripted_driver', scenario: sc.id, ...faultAttrs } });
    for (const s of sc.steps) {
      if (s.kind === 'task') continue;
      if (s.kind === 'retrieve') {
        const inv = await d.authority.invoice(d.tenantId, s.invoice_id);
        const excerpt = inv ? `Invoice ${inv.invoice_id} from ${inv.vendor_name}, ${inv.amount_usd} USD.${inv.note ? ` Note: ${inv.note}` : ''}` : `Invoice ${s.invoice_id} not found.`;
        // Authentic (it really came from the ERP) yet without instruction authority: vendor-supplied text (RFC §5.3).
        await cap.emit('pre_input', { sources: [{ id: `erp-invoice-${s.invoice_id}`, producer: 'sandbox.erp', authenticity: 'verified', instruction_authority: 'none', excerpt }],
          attributes: { ...faultAttrs } });
        continue;
      }
      if (s.kind === 'say') { await cap.emit('post_generation', { text: s.text, attributes: { ...faultAttrs } }); continue; }
      const op = cap.operation(s.tool, s.args);
      const callId = `call-${randomUUID().slice(0, 12)}`;
      await cap.emit('pre_tool', { operation: op, tool_call_id: callId, attributes: { ...faultAttrs } });
      const exec = await d.gateway.execute({ tenantId: d.tenantId, runId, tool: op.tool, operationId: op.operation_id, args: op.args });
      await cap.emit('post_tool', { operation: op, tool_call_id: callId,
        result: { status: exec.result.status, http_status: exec.result.http_status, body: exec.result.body },
        attributes: { receipt_status: exec.receipt.status, ...faultAttrs } });
    }
    await cap.emit('run_finished', { attributes: { status: 'finished' } });
  } catch (e) {
    errors.push((e as Error).message);
    await cap.emit('run_finished', { attributes: { status: 'failed' } }).catch(() => undefined);
  } finally {
    await cap.close();
  }
  return { run_id: runId, errors };
}
