-- One connector row per (tenant, type, externalAccountId): prevents duplicate
-- account rows from the heal + concurrent-connect races. Find-or-create catches
-- 23505 → re-find → reuse.
--
-- NOT `CONCURRENTLY`: the migration runner executes each file inside a
-- transaction, and CREATE INDEX CONCURRENTLY cannot run in one. A plain build
-- takes a brief ACCESS EXCLUSIVE lock, which is fine for the connectors table
-- (control-plane sized). The partial WHERE means only rows that already carry an
-- externalAccountId are indexed, so this is a no-op for the NULL-account legacy
-- rows present at migration time (externalAccountId is backfilled separately).
CREATE UNIQUE INDEX IF NOT EXISTS idx_connectors_tenant_type_account
  ON connectors (tenant_id, type, (config->>'externalAccountId'))
  WHERE config->>'externalAccountId' IS NOT NULL;
