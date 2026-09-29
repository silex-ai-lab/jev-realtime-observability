// T1 (deepseek) implements (docs/CONTRACTS.md §9.1–9.3).
import type { Db } from '../server/storage/db.ts';
import type { ControlDecision } from '../contracts/decision.ts';
import type { ToolCall } from './index.ts';

export async function authorityVersion(db: Db, tenantId: string, call: Pick<ToolCall, 'tool' | 'args'>): Promise<string> {
  throw new Error('authorityVersion: not implemented (T1, Gate C)');
}
export async function revokeApproval(db: Db, tenantId: string, approvalId: string): Promise<void> {
  throw new Error('revokeApproval: not implemented (T1, Gate C)');
}
/** Returns the gateway's requireControl: loads the control by id from control_decisions and verifies §9.2. */
export function createControlVerifier(db: Db): (call: ToolCall, control: ControlDecision | null) => Promise<{ ok: boolean; reason: string }> {
  throw new Error('createControlVerifier: not implemented (T1, Gate C)');
}
export const GATED_TOOLS = ['payments.execute', 'email.send'] as const;
