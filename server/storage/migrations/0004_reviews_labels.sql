-- Review queue and labels (work plan 2026-09-29 batch 1, T4/T5). The tables exist since 0001.
-- One review task per decision: redelivery and retries insert ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS review_tasks_decision ON review_tasks (tenant_id, decision_id);
CREATE INDEX IF NOT EXISTS review_tasks_status ON review_tasks (tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS labels_ref ON labels (tenant_id, ref, question_id);
