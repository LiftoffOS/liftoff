-- Migration 477: the tables the admin kill switches write to.
--
-- src/admin/repository.ts reads and writes disabled_connectors,
-- disabled_workflow_types and platform_status, and no earlier migration
-- created them: without these tables every
-- POST /api/admin/kill-switch/connector/:type/disable,
-- /workflow-type/:type/disable and /global/freeze-writes answers 500 at the
-- INSERT, and the public state endpoints that read them answer the same. The
-- tenant kill switch is unaffected (it writes the tenants row). The connector
-- switch is the operator's way to take a platform vendor out of service
-- without touching its key (src/capability-discovery/vendor-gate.ts).
--
-- Shapes follow the repository exactly: the connector and workflow-type
-- switches are one row per switched-off type, keyed by the type so a repeat
-- disable refreshes the row (ON CONFLICT (connector_type) in the repository)
-- and enable is a DELETE; platform_status is a single row keyed 'global'.
--
-- Platform-scoped, no tenant_id, no RLS: a kill switch is the operator's
-- estate-wide stop by definition.

CREATE TABLE IF NOT EXISTS disabled_connectors (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_type VARCHAR(64) NOT NULL UNIQUE,
  disabled_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled_by    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS disabled_workflow_types (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_type VARCHAR(64) NOT NULL UNIQUE,
  disabled_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled_by   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_status (
  id                   VARCHAR(32) PRIMARY KEY,
  global_writes_frozen BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO platform_status (id, global_writes_frozen)
VALUES ('global', FALSE)
ON CONFLICT (id) DO NOTHING;
