-- Migration 007: HRBP provisioning intent log
--
-- Three tables that implement the intent-before-upstream pattern for the
-- HRBP agent. A run row is opened before the batch starts; event rows record
-- each spec step before and after the upstream PB call; compensation rows
-- record rollback actions taken on failure.
--
-- This gives the stuck-plan resumer a durable view of which specs were
-- partially provisioned and which agents may need to be deleted on retry.

-- One row per provisionWorkforcePlan() invocation.
CREATE TABLE hrbp_provisioning_runs (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     UUID    NOT NULL,
  tenant_id   UUID    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'completed', 'failed', 'compensating', 'compensated')),
  spec_count  INT     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX hrbp_runs_plan_idx ON hrbp_provisioning_runs (plan_id, tenant_id);
CREATE INDEX hrbp_runs_status_idx ON hrbp_provisioning_runs (status, created_at DESC)
  WHERE status = 'running';

-- Intent log: one row per spec step, written before the upstream call.
CREATE TABLE hrbp_provisioning_events (
  id                UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            UUID    NOT NULL REFERENCES hrbp_provisioning_runs (id),
  plan_id           UUID    NOT NULL,
  tenant_id         UUID    NOT NULL,
  spec_id           TEXT    NOT NULL,
  step              TEXT    NOT NULL
                      CHECK (step IN ('distill', 'create_agent', 'update_agent', 'attribute_session')),
  status            TEXT    NOT NULL
                      CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  internal_agent_id UUID,
  idempotency_key   TEXT,
  error_message     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX hrbp_events_run_idx ON hrbp_provisioning_events (run_id, spec_id);

-- Compensation log: actions taken to roll back partial provisioning on failure.
CREATE TABLE hrbp_compensation_log (
  id                UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            UUID    NOT NULL REFERENCES hrbp_provisioning_runs (id),
  plan_id           UUID    NOT NULL,
  tenant_id         UUID    NOT NULL,
  spec_id           TEXT    NOT NULL,
  action            TEXT    NOT NULL
                      CHECK (action IN ('delete_agent', 'rollback_agent')),
  internal_agent_id UUID,
  status            TEXT    NOT NULL
                      CHECK (status IN ('pending', 'completed', 'failed')),
  error_message     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX hrbp_compensation_run_idx ON hrbp_compensation_log (run_id);

COMMENT ON TABLE hrbp_provisioning_runs IS
  'Batch provisioning runs: one row per provisionWorkforcePlan() call.';
COMMENT ON TABLE hrbp_provisioning_events IS
  'Intent log for each spec step. Written before upstream PB call to enable crash recovery.';
COMMENT ON TABLE hrbp_compensation_log IS
  'Rollback actions taken when a provisioning run fails partway through.';
