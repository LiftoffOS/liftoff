-- Compatibility index for the tool_classification_cache identity transition (migration 458).
--
-- 458 re-keyed the unique index to (tool_name, integration_type, tenant) and, in the SAME
-- migration, dropped the old unique index on (tool_name, COALESCE(tenant_id,'__global__')).
-- An application revision from before 458 upserts with
--   ON CONFLICT (tool_name, COALESCE(tenant_id,'__global__'))
-- which Postgres can satisfy ONLY if a unique index on exactly those expressions exists. The
-- migrate job runs before the new revision serves, and a rollback returns to the old revision,
-- so a pre-458 binary can run against a post-458 schema; without the old index its upserts
-- raise 42P10 ("no unique or exclusion constraint matching the ON CONFLICT specification").
--
-- Re-create the old-shape unique index so a pre-458 ON CONFLICT target resolves again. Pending
-- migrations apply in one transaction, so 458's DROP and this CREATE commit atomically and an
-- in-flight old revision never observes a window with no matching index. This deliberately
-- re-imposes the (tool_name, tenant) uniqueness that 458 relaxed, which POSTPONES the newly
-- permitted duplicate identities (two sources sharing a tool name in one tenant). The new app
-- tolerates that: a duplicate-identity insert is a fail-soft cache write (custom-MCP and
-- external-agents paths), degrading to fail-secure HITL until re-cached, never a failed request.
--
-- The name is new because tool_classification_cache_pkey now belongs to 458's index; ON CONFLICT
-- matches by column expression, not by index name, so the name is immaterial.
--
-- FOLLOW-UP, a LATER release once the new app is universally deployed and the rollback window to
-- a pre-458 revision has closed: DROP this index to enable duplicate identities. Shipping that
-- drop separately is what keeps the old-app-compat window covered; dropping it here would
-- defeat the purpose.

CREATE UNIQUE INDEX IF NOT EXISTS tool_classification_cache_tenant_compat_key
  ON tool_classification_cache (tool_name, COALESCE(tenant_id, '__global__'));
