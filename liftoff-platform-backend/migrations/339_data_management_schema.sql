-- Schema for the data-management module (SOC 2 / GDPR): retention policies,
-- export jobs and deletion requests.
--
-- src/data-management/ has shipped routes, a service and a repository against
-- these three tables since it was written, and no migration ever created them.
-- Every call into the module fails with 42P01, which is why the weekly
-- retention sweep returns 500 the moment it reaches the handler.
--
-- Column names and types are taken from src/data-management/repository.ts's
-- INSERT lists and its row mappers, so the existing code works unchanged.

BEGIN;

-- ── Retention policies ─────────────────────────────────────────────────────
-- Operator-managed configuration, not tenant data: one policy per entity type
-- applies across the estate. No tenant_id, therefore no RLS.
CREATE TABLE IF NOT EXISTS retention_policies (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT        NOT NULL,
  entity_type           TEXT        NOT NULL,
  data_classification   TEXT        NOT NULL,
  retention_days        INTEGER     NOT NULL CHECK (retention_days > 0),
  deletion_strategy     TEXT        NOT NULL,
  archive_before_delete BOOLEAN     NOT NULL DEFAULT false,
  enabled               BOOLEAN     NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT retention_policies_entity_type_check CHECK (entity_type IN (
    'workflow', 'action', 'usage_event', 'audit_log', 'connector_record',
    'reflection', 'feedback', 'account', 'tenant'
  )),
  CONSTRAINT retention_policies_classification_check CHECK (data_classification IN (
    'public', 'internal', 'confidential', 'restricted', 'pii'
  )),
  CONSTRAINT retention_policies_strategy_check CHECK (deletion_strategy IN (
    'hard_delete', 'soft_delete', 'anonymize', 'archive_then_delete'
  ))
);

-- findRetentionPoliciesByEntityType filters on both columns.
CREATE INDEX IF NOT EXISTS idx_retention_policies_entity_enabled
  ON retention_policies (entity_type) WHERE enabled;

-- ── Export jobs ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS export_jobs (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL,
  requested_by        TEXT        NOT NULL,
  export_type         TEXT        NOT NULL,
  format              TEXT        NOT NULL,
  scope               JSONB       NOT NULL DEFAULT '{}',
  filters             JSONB       NOT NULL DEFAULT '{}',
  status              TEXT        NOT NULL DEFAULT 'pending',
  progress            INTEGER     NOT NULL DEFAULT 0,
  total_records       BIGINT      NOT NULL DEFAULT 0,
  exported_records    BIGINT      NOT NULL DEFAULT 0,
  output_path         TEXT,
  download_url        TEXT,
  download_expires_at TIMESTAMPTZ,
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,

  CONSTRAINT export_jobs_type_check CHECK (export_type IN (
    'full_tenant_export', 'user_data_export', 'workflow_export',
    'audit_log_export', 'usage_export'
  )),
  CONSTRAINT export_jobs_format_check CHECK (format IN ('json', 'csv', 'parquet')),
  CONSTRAINT export_jobs_status_check CHECK (status IN (
    'pending', 'running', 'completed', 'failed', 'expired'
  ))
);

CREATE INDEX IF NOT EXISTS idx_export_jobs_tenant_created
  ON export_jobs (tenant_id, created_at DESC);
-- processPendingExports claims work by status.
CREATE INDEX IF NOT EXISTS idx_export_jobs_pending
  ON export_jobs (created_at) WHERE status = 'pending';

-- ── Deletion requests ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deletion_requests (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID        NOT NULL,
  requested_by       TEXT        NOT NULL,
  deletion_type      TEXT        NOT NULL,
  scope              JSONB       NOT NULL DEFAULT '{}',
  reason             TEXT        NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'pending_verification',
  verification_token TEXT,
  verified_at        TIMESTAMPTZ,
  scheduled_for      TIMESTAMPTZ NOT NULL,
  executed_at        TIMESTAMPTZ,
  entity_counts      JSONB       NOT NULL DEFAULT '{}',
  error_message      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT deletion_requests_type_check CHECK (deletion_type IN (
    'tenant_deletion', 'user_data_deletion', 'data_category_deletion',
    'retention_cleanup'
  )),
  CONSTRAINT deletion_requests_status_check CHECK (status IN (
    'pending_verification', 'verified', 'scheduled', 'running', 'completed',
    'failed', 'canceled'
  ))
);

CREATE INDEX IF NOT EXISTS idx_deletion_requests_tenant_created
  ON deletion_requests (tenant_id, created_at DESC);
-- verifyDeletionRequest looks the row up by its token alone.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deletion_requests_verification_token
  ON deletion_requests (verification_token) WHERE verification_token IS NOT NULL;
-- The executor sweeps for work that is due.
CREATE INDEX IF NOT EXISTS idx_deletion_requests_due
  ON deletion_requests (scheduled_for) WHERE status IN ('verified', 'scheduled');

-- ── RLS ────────────────────────────────────────────────────────────────────
-- export_jobs and deletion_requests carry tenant data and are read through the
-- scoped wrappers. retention_policies is estate-wide operator config and stays
-- out. Both policies are FORCE so the owning role is bound by them too.
ALTER TABLE export_jobs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_jobs        FORCE  ROW LEVEL SECURITY;
ALTER TABLE deletion_requests  ENABLE ROW LEVEL SECURITY;
ALTER TABLE deletion_requests  FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_export_jobs ON export_jobs;
CREATE POLICY tenant_isolation_export_jobs ON export_jobs
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation_deletion_requests ON deletion_requests;
CREATE POLICY tenant_isolation_deletion_requests ON deletion_requests
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMIT;
