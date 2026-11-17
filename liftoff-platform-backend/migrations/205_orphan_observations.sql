-- Migration 204: orphan_observations — reconciler tracks runtime-side mappings
-- that have no corresponding PB internal_agents row. Orphans observed
-- continuously for >24h are auto-tombstoned. Rows clear themselves when the
-- orphan disappears (mapping deleted) — handled in reconciler.

CREATE TABLE orphan_observations (
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  runtime_agent_id   UUID NOT NULL,
  internal_agent_id  UUID NOT NULL,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  republished        BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (tenant_id, runtime_agent_id)
);

CREATE INDEX orphan_observations_last_seen
  ON orphan_observations (last_seen_at);

-- No RLS — operator-only access.
