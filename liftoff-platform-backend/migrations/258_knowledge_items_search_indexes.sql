-- WS-12.5 — composite index for knowledge_items search.
-- Common search shape is (tenant_id, connector_id).
--
-- node-pg-migrate wraps each migration in a transaction, and Postgres rejects
-- CREATE INDEX CONCURRENTLY inside a transaction with SQLSTATE 25001
-- "PreventInTransactionBlock". Convention in this repo (per migration 033 +
-- 118) is to use plain CREATE INDEX for migration-managed indexes — the brief
-- table lock during build is acceptable.
--
-- The plan's WS-12 also called for a GIN index on `content_tsv` but the
-- knowledge_items table does not carry a tsvector column today (the search
-- path uses websearch_to_tsquery against `excerpt`+`title` at query time;
-- see knowledge/repository.ts). The FTS index will land alongside any
-- future migration that materializes content_tsv as a generated column.

CREATE INDEX IF NOT EXISTS knowledge_items_tenant_connector_idx
  ON knowledge_items (tenant_id, connector_id);
