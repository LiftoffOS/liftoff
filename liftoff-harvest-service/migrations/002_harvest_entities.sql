-- Up Migration

CREATE TABLE IF NOT EXISTS harvest_entities (
  connector_id      TEXT        NOT NULL,
  entity_id         TEXT        NOT NULL,
  content_hash      TEXT        NOT NULL,
  memory_id         TEXT,
  memory_type       TEXT,
  expires_at        TIMESTAMPTZ,
  last_harvested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connector_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_he_connector ON harvest_entities(connector_id);

-- Down Migration

DROP TABLE IF EXISTS harvest_entities;
