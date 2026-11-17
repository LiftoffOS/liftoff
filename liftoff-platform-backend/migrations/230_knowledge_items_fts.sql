ALTER TABLE knowledge_items
  ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(excerpt, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(extracted_text, '')), 'C')
  ) STORED;

CREATE INDEX knowledge_items_search_tsv_idx
  ON knowledge_items USING GIN (search_tsv);

CREATE INDEX knowledge_items_tenant_connector_synced_idx
  ON knowledge_items (tenant_id, connector_id)
  WHERE sync_status = 'synced';
