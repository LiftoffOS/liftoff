-- Operator dashboard: per-tenant alerts
-- System-generated alerts surfaced in the operator dashboard and acknowledged by ops staff.
-- tenant_id is nullable to support platform-wide (non-tenant-scoped) alerts.

CREATE TABLE IF NOT EXISTS alerts (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        REFERENCES tenants (id) ON DELETE CASCADE,
  severity          TEXT        NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  type              TEXT        NOT NULL,
  message           TEXT        NOT NULL,
  acknowledged      BOOLEAN     NOT NULL DEFAULT FALSE,
  acknowledged_by   TEXT,
  acknowledged_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_tenant_created       ON alerts (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_severity             ON alerts (severity);
CREATE INDEX IF NOT EXISTS idx_alerts_unacknowledged       ON alerts (acknowledged, created_at DESC) WHERE NOT acknowledged;
