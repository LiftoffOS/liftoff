-- Durable outbox for delivering late-feedback trust decisions to the governance engine.
--
-- When a late-feedback review is submitted, a trust-decisions payload is written to this
-- table in the SAME transaction as the hitl_late_feedback row. A background worker drains
-- it to POST /api/governance/action-trust/decisions. Idempotent on (tenant_id, feedback_id);
-- the governance side is additionally idempotent on its source_key.

CREATE TABLE late_feedback_trust_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  feedback_id UUID NOT NULL,
  payload JSONB NOT NULL,                                  -- the PostDecisionsBody sent to governance
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','completed','failed')),
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 10,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, feedback_id)
);

CREATE INDEX idx_lfto_claim ON late_feedback_trust_outbox (next_attempt_at)
  WHERE status = 'pending';

ALTER TABLE late_feedback_trust_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE late_feedback_trust_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY lfto_tenant ON late_feedback_trust_outbox
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
