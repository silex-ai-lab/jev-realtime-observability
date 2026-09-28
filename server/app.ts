// T2 (planner) implements. Signature fixed by docs/CONTRACTS.md §4 so tests can be written against it.
import type { Db } from './storage/db.ts';
import type { JudgeClient, JudgeConfig } from './judges/index.ts';

export interface TenantSetup {
  tenant_id: string;
  name: string;
  keys: { ingest: string; reader: string; gateway: string; admin: string };
}
export interface AppOptions {
  db?: Db;
  judge: JudgeConfig | null;
  sourceMode: 'live_sandbox_shadow' | 'live_sandbox_gate';
  tenants: TenantSetup[];
  worker: { autostart: boolean; leaseMs?: number; realtimeTtlMs?: number };
  port?: number;
}
export interface App {
  url: string;
  db: Db;
  judge: JudgeClient | null;
  worker: { drain(): Promise<void>; stop(): Promise<void> };
  close(): Promise<void>;
}
export async function createApp(opts: AppOptions): Promise<App> {
  throw new Error('createApp: not implemented (T2)');
}
