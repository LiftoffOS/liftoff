-- Migration 010: Workforce audit log — monthly partitioned
--
-- Immutable audit trail for all workforce-service operations. Range-partitioned
-- by occurred_at for efficient retention pruning (DROP old partitions rather
-- than DELETE with a predicate scan).
--
-- Partitions are created here for current + next 3 months. A scheduled job
-- (or manual operation) must create future partitions before each month turns.

CREATE TABLE workforce_audit_log (
  id           UUID        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    UUID        NOT NULL,
  account_id   UUID,
  action       TEXT        NOT NULL,
  entity_type  TEXT,
  entity_id    UUID,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data         JSONB       NOT NULL DEFAULT '{}'
) PARTITION BY RANGE (occurred_at);

CREATE INDEX workforce_audit_log_tenant_idx
  ON workforce_audit_log (tenant_id, occurred_at DESC);

CREATE INDEX workforce_audit_log_action_idx
  ON workforce_audit_log (action, occurred_at DESC);

-- Initial partitions: 2026-04 through 2026-07
CREATE TABLE workforce_audit_log_2026_04
  PARTITION OF workforce_audit_log
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

CREATE TABLE workforce_audit_log_2026_05
  PARTITION OF workforce_audit_log
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE TABLE workforce_audit_log_2026_06
  PARTITION OF workforce_audit_log
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE workforce_audit_log_2026_07
  PARTITION OF workforce_audit_log
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

COMMENT ON TABLE workforce_audit_log IS
  'Immutable audit trail. Monthly range-partitioned; drop old partitions for retention.';
COMMENT ON COLUMN workforce_audit_log.data IS
  'Structured context for the action: entity fields, before/after state, request metadata.';
