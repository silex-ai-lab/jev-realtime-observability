-- Gate B: outcome verification state machine (RFC §8) and fitted calibrations (RFC §10, §12).

-- One row per executed operation under verification. The verifier polls with bounded backoff until
-- a terminal state or the deadline. Every state change is also appended to outcomes (history).
CREATE TABLE IF NOT EXISTS outcome_checks (
  tenant_id     text NOT NULL,
  operation_id  text NOT NULL,
  run_id        text NOT NULL,
  event_id      text NOT NULL,                 -- the post_tool event that started verification
  tool          text NOT NULL,
  state         text NOT NULL CHECK (state IN ('pending', 'verified_success', 'verified_failure', 'mismatch', 'unknown_after_deadline')),
  expected      jsonb NOT NULL,                -- what the agent asked for (payee, amount, recipient digest…)
  attempts      int NOT NULL DEFAULT 0,
  next_check_at timestamptz NOT NULL,
  deadline_at   timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation_id)
);
CREATE INDEX IF NOT EXISTS outcome_checks_due ON outcome_checks (state, next_check_at);

CREATE TABLE IF NOT EXISTS calibrations (
  calibration_id text PRIMARY KEY,
  judge_source   text NOT NULL,
  rubric_id      text NOT NULL,
  question_id    text NOT NULL,
  body           jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Every tool call the gateway was asked to perform, captured or not: the denominator of capture coverage (RFC §11.1).
CREATE TABLE IF NOT EXISTS gateway_attempts (
  tenant_id    text NOT NULL,
  operation_id text NOT NULL,
  run_id       text NOT NULL,
  tool         text NOT NULL,
  at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation_id)
);
