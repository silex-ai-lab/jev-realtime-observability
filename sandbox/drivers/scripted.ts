// scripted_driver (RFC §4): runs a fixed step list against the real sandbox tool gateway and
// captures every boundary. In shadow mode it never waits for, or reads, a decision.
import { randomUUID } from 'node:crypto';
import { createCapture } from '../../sdk/index.ts';
import type { AuthorityReader, ToolGateway } from '../index.ts';
import type { Scenario } from '../scenarios/index.ts';
import { isGatedTool } from '../control.ts';

export interface DriverDeps {
  baseUrl: string;
  ingestKey: string;
  tenantId: string;
  gateway: ToolGateway;
  authority: AuthorityReader;
  mirrorOtlp: boolean;
  /** Gate C: ask /v1/preflight before gated tools and pass the control to the gateway. */
  gate?: boolean;
}

export async function runScripted(d: DriverDeps, sc: Scenario, runId = `run-${sc.id.toLowerCase()}-${randomUUID().slice(0, 8)}`): Promise<{ run_id: string; errors: string[] }> {
  const cap = createCapture({ baseUrl: d.baseUrl, apiKey: d.ingestKey, producerId: 'scripted-driver', runId, mirrorOtlp: d.mirrorOtlp });
  const errors: string[] = [];
  const faultAttrs: Record<string, string> = sc.fault ? { fault: sc.fault } : {};
  try {
    const goal = sc.steps.find(s => s.kind === 'task');
    await cap.emit('run_started', { actor: { kind: 'user', id: sc.actor ?? 'finance-user' }, task_goal: goal?.kind === 'task' ? goal.goal : undefined,
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
      if (s.kind === 'retrieve_alert') {
        const al = d.authority.alert ? await d.authority.alert(d.tenantId, s.alert_id) : null;
        const excerpt = al ? `Alert ${al.alert_id}: ${al.title}. Raw log: ${al.raw_log}` : `Alert ${s.alert_id} not found.`;
        // Authentic (it really came from the SIEM) yet without instruction authority: log text an attacker can write into.
        await cap.emit('pre_input', { sources: [{ id: `siem-alert-${s.alert_id}`, producer: 'sandbox.siem', authenticity: 'verified', instruction_authority: 'none', excerpt }],
          attributes: { ...faultAttrs } });
        continue;
      }
      if (s.kind === 'say') { await cap.emit('post_generation', { text: s.text, attributes: { ...faultAttrs } }); continue; }
      const op = cap.operation(s.tool, s.args);
      const callId = `call-${randomUUID().slice(0, 12)}`;
      const gated = Boolean(d.gate) && isGatedTool(op.tool);
      let control = null, gateAttrs: Record<string, string | number> = {};
      if (gated) {
        // The preflight records the pre_tool event itself and returns a control bound to exactly this call.
        const pf = await cap.preflight(op, { tool_call_id: callId, attributes: { ...faultAttrs } });
        control = pf.response.control;
        gateAttrs = { control_id: control.control_id, control_action: control.action, sdk_preflight_ms: Math.round(pf.sdk_preflight_ms) };
      } else {
        await cap.emit('pre_tool', { operation: op, tool_call_id: callId, attributes: { ...faultAttrs } });
      }
      const exec = await d.gateway.execute({ tenantId: d.tenantId, runId, tool: op.tool, operationId: op.operation_id, args: op.args }, control);
      await cap.emit('post_tool', { operation: op, tool_call_id: callId,
        result: { status: exec.result.status, http_status: exec.result.http_status, body: exec.result.body },
        attributes: { receipt_status: exec.receipt.status, ...gateAttrs, ...faultAttrs } });
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
