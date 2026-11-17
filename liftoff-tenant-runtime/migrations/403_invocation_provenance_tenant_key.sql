-- The provenance table's duplicate rule includes the tenant.
--
-- Rows were keyed by invocation and fact alone. Two tenants can produce the
-- same invocation id and the same fact — rare, since invocation ids are UUIDs,
-- but not impossible — and when they do the second tenant's row conflicts
-- with one it cannot see through the policy, and the duplicate rule silently
-- drops a fact that belongs to a different tenant. A tenant-scoped table's
-- uniqueness is tenant-scoped.
--
-- The writer's ON CONFLICT names no target from this change on, so it follows
-- whichever key the table has; the reader filters by invocation under the
-- policy's tenant, and the new key still leads with both. The image running
-- while this applies names the old key and has its inserts refused until its
-- replacement is serving; it retries each record in the background, and the
-- window is the length of one deploy.

ALTER TABLE invocation_provenance
  DROP CONSTRAINT IF EXISTS invocation_provenance_pkey;

ALTER TABLE invocation_provenance
  ADD CONSTRAINT invocation_provenance_pkey
  PRIMARY KEY (tenant_id, invocation_id, kind, entity_type, value);
