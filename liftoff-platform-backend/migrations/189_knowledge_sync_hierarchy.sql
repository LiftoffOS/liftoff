-- Phase 1: parent_id hierarchy, content extraction columns, and webhook subscription tracking

-- knowledge_items hierarchy + extraction
ALTER TABLE knowledge_items
  ADD COLUMN parent_id          UUID        NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  ADD COLUMN extracted_text     TEXT        NULL,
  ADD COLUMN extraction_status  TEXT        NOT NULL DEFAULT 'none'
    CHECK (extraction_status IN ('none', 'pending', 'extracting', 'done', 'error')),
  ADD COLUMN extracted_at       TIMESTAMPTZ NULL;

CREATE INDEX knowledge_items_parent_id_idx ON knowledge_items(parent_id)
  WHERE parent_id IS NOT NULL;

CREATE INDEX knowledge_items_extraction_status_idx ON knowledge_items(extraction_status)
  WHERE extraction_status IN ('pending', 'extracting');

-- webhook subscriptions for real-time folder sync
CREATE TABLE knowledge_webhook_subscriptions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT        NOT NULL,
  connector_id    TEXT        NOT NULL,
  connector_type  TEXT        NOT NULL,
  external_id     TEXT        NOT NULL,
  subscription_id TEXT        NOT NULL,
  channel_token   TEXT        NOT NULL,
  expires_at      TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (connector_id, external_id)
);

CREATE INDEX knowledge_webhook_subscriptions_tenant_idx ON knowledge_webhook_subscriptions(tenant_id);
CREATE INDEX knowledge_webhook_subscriptions_expires_idx ON knowledge_webhook_subscriptions(expires_at)
  WHERE expires_at IS NOT NULL;
