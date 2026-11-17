-- Put `connector_content` under RLS before it starts holding customer content.
--
-- The table has existed since migration 114 with a tenant_id column and no row
-- level security. The component that writes it, `content-indexer`, is off
-- unless explicitly enabled (`CONNECTOR_CONTENT_INDEXING_ENABLED=true`); until
-- an operator enables it, the table stays empty.
--
-- Once indexing is on, this table holds redacted-but-real customer business
-- content — mail bodies, documents, ticket text — for thirty days. Enabling the
-- writer while the table has no tenant policy would create the exposure, so the
-- policy comes first.
--
-- Safe to apply against live traffic: there is no backfill, and the readers and
-- the writer go through `withTenantScope`, so a tenant's queries return the same
-- rows as before.

ALTER TABLE connector_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_content FORCE ROW LEVEL SECURITY;

-- Fail-loud, matching migrations 370 and 371 and the convention 079 documents.
-- `current_setting('app.tenant_id')` WITHOUT the `true` second argument: off a
-- scope this RAISES instead of returning NULL. The silent variant compares
-- tenant_id to NULL, which is never true, so every read returns ZERO ROWS and
-- succeeds — and for a retrieval source, zero rows is indistinguishable from
-- "this workspace has nothing indexed". That is the exact false statement the
-- indexed-context source exists to avoid making, so it must not be reachable
-- through a missing GUC.
CREATE POLICY connector_content_tenant ON connector_content
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
