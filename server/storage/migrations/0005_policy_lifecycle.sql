-- Policy lifecycle (plan D5): per-tenant policy versions and draft → published → active → retired.
-- `policy_versions.policy_version` was a global primary key, so the bootstrap row `policy-a1` could exist
-- for only one tenant; the second tenant's bootstrap insert was swallowed and it ran with no active row.
-- Switch the key to (tenant_id, policy_version) and enforce at most one active row per tenant.
-- The bootstrap row itself is created by `ensureActivePolicy` in code (single source of DEFAULT_POLICY);
-- no SQL backfill that could drift from the constant.

ALTER TABLE policy_versions DROP CONSTRAINT policy_versions_pkey;
ALTER TABLE policy_versions ADD PRIMARY KEY (tenant_id, policy_version);

CREATE UNIQUE INDEX IF NOT EXISTS policy_versions_one_active
  ON policy_versions (tenant_id) WHERE status = 'active';

-- History of every activate/rollback switch, ordered by id for a deterministic "newest" rollback target.
CREATE TABLE IF NOT EXISTS policy_activations (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL,
  from_version text NOT NULL,
  to_version   text NOT NULL,
  actor        text NOT NULL,
  at           timestamptz NOT NULL DEFAULT now()
);
