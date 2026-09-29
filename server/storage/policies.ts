// Policy lifecycle storage (plan D5). Per-tenant active policy with draft → published → active → retired.
// `ensureActivePolicy` is the single source of the bootstrap row: no SQL backfill that could drift from
// DEFAULT_POLICY. Steady-state reads take a plain SELECT; the advisory lock is held only to bootstrap or
// to switch, so policy reads do not serialise on the lock.
import type { Queryable } from './db.ts';
import { DEFAULT_POLICY } from '../policy/index.ts';

export interface ActivePolicyRow {
  policy_version: string;
  body: unknown;
}

export interface PolicyVersionRow {
  policy_version: string;
  status: string;
  body: unknown;
  base_version: string | null;
}

/** Serialises per-tenant policy writes; the worker already uses this advisory-lock idiom (server/worker). */
export function lockPolicy(q: Queryable, tenantId: string): Promise<unknown> {
  return q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`policy/${tenantId}`]);
}

export async function getActivePolicyRow(q: Queryable, tenantId: string): Promise<ActivePolicyRow | null> {
  const r = await q.query<{ policy_version: string; body: unknown }>(
    `SELECT policy_version, body FROM policy_versions WHERE tenant_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    [tenantId],
  );
  return r.rows[0] ?? null;
}

/** Assumes the tenant policy lock is held. Reads the active row, bootstrapping DEFAULT_POLICY if none. */
export async function bootstrapActivePolicy(q: Queryable, tenantId: string): Promise<ActivePolicyRow> {
  const existing = await getActivePolicyRow(q, tenantId);
  if (existing) return existing;
  await q.query(
    `INSERT INTO policy_versions (policy_version, tenant_id, base_version, status, body, actor)
     VALUES ($1, $2, NULL, 'active', $3, 'bootstrap')
     ON CONFLICT (tenant_id, policy_version) DO NOTHING`,
    [DEFAULT_POLICY.policy_version, tenantId, JSON.stringify(DEFAULT_POLICY)],
  );
  return (await getActivePolicyRow(q, tenantId)) ?? { policy_version: DEFAULT_POLICY.policy_version, body: DEFAULT_POLICY };
}

/** Fast path: a plain read; the lock is taken only when no active row exists. */
export async function ensureActivePolicy(q: Queryable, tenantId: string): Promise<ActivePolicyRow> {
  const fast = await getActivePolicyRow(q, tenantId);
  if (fast) return fast;
  await lockPolicy(q, tenantId);
  return bootstrapActivePolicy(q, tenantId);
}

export async function getPolicyVersion(q: Queryable, tenantId: string, version: string): Promise<PolicyVersionRow | null> {
  const r = await q.query<{ policy_version: string; status: string; body: unknown; base_version: string | null }>(
    `SELECT policy_version, status, body, base_version FROM policy_versions WHERE tenant_id = $1 AND policy_version = $2`,
    [tenantId, version],
  );
  return r.rows[0] ?? null;
}

export async function setPolicyStatus(q: Queryable, tenantId: string, version: string, status: string): Promise<void> {
  await q.query(`UPDATE policy_versions SET status = $3 WHERE tenant_id = $1 AND policy_version = $2`, [tenantId, version, status]);
}

export async function insertActivation(q: Queryable, tenantId: string, fromVersion: string, toVersion: string, actor: string): Promise<void> {
  await q.query(`INSERT INTO policy_activations (tenant_id, from_version, to_version, actor) VALUES ($1, $2, $3, $4)`,
    [tenantId, fromVersion, toVersion, actor]);
}

export async function newestActivationTo(q: Queryable, tenantId: string, toVersion: string): Promise<{ from_version: string; to_version: string } | null> {
  const r = await q.query<{ from_version: string; to_version: string }>(
    `SELECT from_version, to_version FROM policy_activations WHERE tenant_id = $1 AND to_version = $2 ORDER BY id DESC LIMIT 1`,
    [tenantId, toVersion],
  );
  return r.rows[0] ?? null;
}
