-- Core schema (RFC §9.1). PostgreSQL dialect; runs unchanged on PGlite and on a real Postgres.
-- Records are append-only where the RFC says history must not be rewritten
-- (events, snapshots, evaluations, decisions, receipts, outcomes, audit_log).

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id   text PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- API keys are stored hashed. role: ingest (runner/SDK), reader (UI), gateway (tool executor), admin (policy publish).
CREATE TABLE IF NOT EXISTS api_keys (
  key_hash    text PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants(tenant_id),
  role        text NOT NULL CHECK (role IN ('ingest', 'reader', 'gateway', 'admin')),
  label       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

CREATE TABLE IF NOT EXISTS runs (
  tenant_id   text NOT NULL REFERENCES tenants(tenant_id),
  run_id      text NOT NULL,
  driver      text NOT NULL,               -- scripted_driver | llm_agent_driver
  scenario    text,
  provenance  jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'finished', 'failed', 'stopped')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (tenant_id, run_id)
);

CREATE TABLE IF NOT EXISTS events (
  tenant_id       text NOT NULL REFERENCES tenants(tenant_id),
  event_id        text NOT NULL,
  run_id          text NOT NULL,
  boundary        text NOT NULL,
  producer_id     text NOT NULL,
  producer_seq    bigint NOT NULL,
  source_event_id text,
  occurred_at     timestamptz NOT NULL,
  received_at     timestamptz NOT NULL,
  ingest_path     text NOT NULL CHECK (ingest_path IN ('sdk', 'otlp')),
  content_digest  text NOT NULL,             -- sha256 of canonical body: same id + different content = conflict
  body            jsonb NOT NULL,
  PRIMARY KEY (tenant_id, event_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS events_source_dedup ON events (tenant_id, source_event_id) WHERE source_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_run ON events (tenant_id, run_id, received_at);

CREATE TABLE IF NOT EXISTS snapshots (
  tenant_id   text NOT NULL,
  snapshot_id text PRIMARY KEY,
  event_id    text NOT NULL,
  revision    int NOT NULL DEFAULT 1,
  body        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS snapshots_event ON snapshots (tenant_id, event_id);

-- Durable job queue with leases (RFC §9.1). One realtime job per (tenant, event, kind).
CREATE TABLE IF NOT EXISTS evaluation_jobs (
  job_id      bigserial PRIMARY KEY,
  tenant_id   text NOT NULL,
  event_id    text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('realtime', 'diagnostic', 'model_reeval')),
  priority    int NOT NULL DEFAULT 0,       -- higher first; realtime > diagnostic > model_reeval
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'leased', 'done', 'expired', 'failed')),
  lease_until timestamptz,
  attempts    int NOT NULL DEFAULT 0,
  not_after   timestamptz NOT NULL,         -- past this, the job expires instead of running (RFC §6.5)
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  last_error  text,
  UNIQUE (tenant_id, event_id, kind)
);
CREATE INDEX IF NOT EXISTS jobs_ready ON evaluation_jobs (status, priority DESC, job_id);

CREATE TABLE IF NOT EXISTS evaluations (
  tenant_id     text NOT NULL,
  evaluation_id text PRIMARY KEY,
  event_id      text NOT NULL,
  snapshot_id   text NOT NULL,
  kind          text NOT NULL,
  status        text NOT NULL,
  judge_source  text,
  body          jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS evaluations_event ON evaluations (tenant_id, event_id);

CREATE TABLE IF NOT EXISTS signals (
  tenant_id     text NOT NULL,
  evaluation_id text NOT NULL REFERENCES evaluations(evaluation_id),
  question_id   text NOT NULL,
  body          jsonb NOT NULL,
  PRIMARY KEY (evaluation_id, question_id)
);

-- Every outbound judge HTTP attempt, whatever its outcome (RFC §6.4, §11.3). Also the
-- counter the "policy-only replay makes zero model calls" test reads.
CREATE TABLE IF NOT EXISTS judge_calls (
  call_id           bigserial PRIMARY KEY,
  tenant_id         text NOT NULL,
  evaluation_id     text,
  caller            text NOT NULL CHECK (caller IN ('realtime', 'diagnostic', 'model_reeval', 'preflight', 'eval', 'healthcheck')),
  client_request_id text NOT NULL,
  request_hash      text NOT NULL,
  judge_source      text,
  status            text NOT NULL,
  http_status       int,
  rtt_ms            double precision,
  input_tokens      int,
  output_tokens     int,
  billing           text NOT NULL,
  at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS policy_versions (
  policy_version text PRIMARY KEY,
  tenant_id      text NOT NULL,
  base_version   text,
  status         text NOT NULL CHECK (status IN ('draft', 'published', 'active', 'retired')),
  body           jsonb NOT NULL,
  actor          text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS decisions (
  tenant_id      text NOT NULL,
  decision_id    text PRIMARY KEY,
  event_id       text NOT NULL,
  evaluation_id  text,
  policy_version text NOT NULL,
  recommended    text NOT NULL,
  replay_of      text,                        -- decision_id this is a policy-only replay of
  body           jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS decisions_event ON decisions (tenant_id, event_id);

-- Gate B / C records (created now; used from Gate B/C).
CREATE TABLE IF NOT EXISTS control_decisions (
  tenant_id   text NOT NULL,
  control_id  text PRIMARY KEY,
  operation_id text NOT NULL,
  nonce       text NOT NULL UNIQUE,
  consumed_at timestamptz,
  revoked_at  timestamptz,
  body        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS execution_receipts (
  tenant_id    text NOT NULL,
  receipt_id   text PRIMARY KEY,
  operation_id text NOT NULL,
  body         jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS outcomes (
  tenant_id    text NOT NULL,
  outcome_id   text PRIMARY KEY,
  operation_id text NOT NULL,
  state        text NOT NULL,
  body         jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS review_tasks (
  tenant_id   text NOT NULL,
  review_id   text PRIMARY KEY,
  decision_id text NOT NULL,
  status      text NOT NULL CHECK (status IN ('open', 'resolved_allow', 'resolved_deny', 'expired')),
  body        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Persisted outbox: SSE reads from here by cursor, so reconnects resume and nothing lives only in memory.
CREATE TABLE IF NOT EXISTS outbox (
  cursor     bigserial PRIMARY KEY,
  tenant_id  text NOT NULL,
  kind       text NOT NULL,
  ref_id     text NOT NULL,
  run_id     text,
  payload    jsonb NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_tenant_cursor ON outbox (tenant_id, cursor);

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id  bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  actor     text NOT NULL,
  action    text NOT NULL,
  detail    jsonb NOT NULL,
  at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS labels (
  label_id       text PRIMARY KEY,
  tenant_id      text NOT NULL,
  ref            text NOT NULL,
  question_id    text NOT NULL,
  value          jsonb NOT NULL,
  evidence_class text NOT NULL CHECK (evidence_class IN ('benchmark_ground_truth_derived', 'heuristic_derived', 'human_reviewed')),
  source         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
