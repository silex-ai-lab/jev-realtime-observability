-- At most one original (non-replay) decision per event. Backstop for the worker's idempotent completion
-- when several connections complete the same event concurrently (real Postgres pool).
CREATE UNIQUE INDEX IF NOT EXISTS decisions_one_original_per_event ON decisions (tenant_id, event_id) WHERE replay_of IS NULL;
