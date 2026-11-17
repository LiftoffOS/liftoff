CREATE TABLE knowledge_items (
  id              UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id       TEXT         NOT NULL,
  title           TEXT         NOT NULL DEFAULT '',
  source_url      TEXT         NULL,
  connector_id    TEXT         NULL,
  connector_type  TEXT         NULL,
  external_id     TEXT         NULL,
  content_type    TEXT         NOT NULL DEFAULT 'document'
    CHECK (content_type IN ('article', 'document', 'page', 'folder', 'collection', 'url')),
  excerpt         TEXT         NULL,
  metadata        JSONB        NOT NULL DEFAULT '{}',
  import_mode     TEXT         NOT NULL DEFAULT 'manual'
    CHECK (import_mode IN ('manual', 'auto_import', 'file_select')),
  sync_status     TEXT         NOT NULL DEFAULT 'pending'
    CHECK (sync_status IN ('pending', 'syncing', 'synced', 'error')),
  last_synced_at  TIMESTAMPTZ  NULL,
  sync_error      TEXT         NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX knowledge_items_tenant_idx ON knowledge_items(tenant_id);
CREATE INDEX knowledge_items_connector_idx ON knowledge_items(tenant_id, connector_id) WHERE connector_id IS NOT NULL;
CREATE UNIQUE INDEX knowledge_items_external_unique ON knowledge_items(tenant_id, connector_id, external_id)
  WHERE connector_id IS NOT NULL AND external_id IS NOT NULL;
