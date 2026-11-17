-- Operator dashboard: system incidents
-- Platform-wide incidents with affected components and update timeline.
-- affected_tenants stores tenant UUIDs; affected_components stores service names.
-- updates is an ordered JSON array of { timestamp, message, author } entries.

CREATE TABLE IF NOT EXISTS incidents (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title                TEXT        NOT NULL,
  severity             TEXT        NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status               TEXT        NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  started_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at          TIMESTAMPTZ,
  affected_components  TEXT[]      NOT NULL DEFAULT '{}',
  affected_tenants     UUID[]      NOT NULL DEFAULT '{}',
  updates              JSONB       NOT NULL DEFAULT '[]',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent column additions in case the table existed from an earlier migration
-- run with a different schema (CREATE TABLE IF NOT EXISTS would have been a no-op).
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS resolved_at         TIMESTAMPTZ;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS affected_components TEXT[]      NOT NULL DEFAULT '{}';
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS affected_tenants    UUID[]      NOT NULL DEFAULT '{}';
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS updates             JSONB       NOT NULL DEFAULT '[]';
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_incidents_started_at  ON incidents (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_status      ON incidents (status);
