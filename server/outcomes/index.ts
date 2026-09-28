// T1 (deepseek) implements (docs/CONTRACTS.md §8.3). Independent read-back verifier (RFC §8).
import type { Db, Queryable } from '../storage/db.ts';
import type { AuthorityReader } from '../../sandbox/index.ts';

export interface OutcomeVerifierOptions { deadlineMs: Record<string, number>; backoffMs: number[] }
export interface TrackInput {
  tenantId: string; runId: string; eventId: string; tool: string; operationId: string;
  expected: Record<string, string | number | boolean | null>;
}
export interface OutcomeVerifier {
  /** Idempotent per (tenant, operation). Only for executed side-effect tools. */
  track(q: Queryable, t: TrackInput): Promise<void>;
  /** Processes checks whose next_check_at has passed; returns how many were processed. */
  tick(): Promise<number>;
}
export const OUTCOME_TOOLS = ['payments.execute', 'email.send'] as const;
export function createOutcomeVerifier(db: Db, authority: AuthorityReader, opts: OutcomeVerifierOptions): OutcomeVerifier {
  throw new Error('createOutcomeVerifier: not implemented (T1, Gate B)');
}
