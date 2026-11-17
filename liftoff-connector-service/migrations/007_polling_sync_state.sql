-- Migration 002: Connector polling sync state.
--
-- Tracks per-connector-per-entity-type polling cursors so the scheduler
-- can do incremental syncs (since last_sync_at) and resume mid-page
-- (last_page_token) after a restart.

CREATE TABLE connector_sync_state (
  connector_id    UUID         NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  entity_type     TEXT         NOT NULL,
  last_page_token TEXT,
  last_sync_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  next_sync_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (connector_id, entity_type)
);

CREATE INDEX idx_connector_sync_state_due
  ON connector_sync_state (next_sync_at);
