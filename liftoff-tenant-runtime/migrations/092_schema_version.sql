-- schema_version tracking
-- Startup schema-check reads this; readiness probe blocks traffic until the
-- expected version is present. Supports rolling deploys.

CREATE TABLE IF NOT EXISTS schema_version (
  component VARCHAR(64) PRIMARY KEY,
  version INTEGER NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_version (component, version) VALUES ('chat_turn_runtime', 5)
  ON CONFLICT (component) DO UPDATE SET version = 5, applied_at = NOW();

COMMENT ON TABLE schema_version IS
  'Per-component schema version. Used by src/startup/schema-check.ts readiness probe.';
