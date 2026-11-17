-- Migration 241: convert knowledge_items.tenant_id from TEXT to UUID
-- and add the FK to tenants(id) that should have been there all along.
--
-- Background
-- ----------
-- knowledge_items was created in migration 183 with `tenant_id TEXT NOT NULL`
-- and no FK — pre-dates the platform's UUID conventions. All modern tables
-- (internal_agents, tenants, billing_*, etc.) use `tenant_id UUID REFERENCES
-- tenants(id)`. The TEXT mismatch caused real friction in migration 240
-- (knowledge_outbox): outbox.tenant_id is UUID + FK, but the parent column
-- on knowledge_items is TEXT, so any historical row with a non-UUID
-- tenant_id would fail the outbox INSERT and roll back the whole
-- knowledge_items insert.
--
-- The application has only ever written UUID tenant_ids into knowledge_items
-- (tenantAuthMiddleware sets req.ctx.tenantId from a UUID-keyed JWT), so the
-- defensive DELETEs below should find zero rows in well-maintained
-- environments. They exist to prevent the ALTER TYPE / ADD FK from failing
-- catastrophically against any unexpected legacy data.
--
-- Scope: only knowledge_items. knowledge_webhook_subscriptions also has
-- `tenant_id TEXT` but is unrelated to the event-driven outbox path; left
-- to a follow-up. pinned_knowledge_backfill_report is an operator audit
-- table without an FK — also out of scope here.

BEGIN;

-- Step 1: log how many rows we're about to drop, for ops visibility in the
-- migration job output. Two failure modes:
--   a) tenant_id is not a valid UUID string (would crash ALTER TYPE)
--   b) tenant_id IS a UUID but no longer matches a tenants row (would crash
--      ADD FK after the type conversion)
DO $$
DECLARE
  bad_format_count INT;
  orphan_count INT;
BEGIN
  SELECT COUNT(*) INTO bad_format_count
  FROM knowledge_items
  WHERE tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

  IF bad_format_count > 0 THEN
    RAISE NOTICE 'Migration 241: deleting % knowledge_items rows with non-UUID tenant_id', bad_format_count;
  END IF;

  SELECT COUNT(*) INTO orphan_count
  FROM knowledge_items ki
  WHERE ki.tenant_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = ki.tenant_id::uuid);

  IF orphan_count > 0 THEN
    RAISE NOTICE 'Migration 241: deleting % knowledge_items rows orphaned from tenants', orphan_count;
  END IF;
END$$;

-- Step 2: remove rows with non-UUID tenant_id. ON DELETE CASCADE on
-- knowledge_item_chunks, knowledge_outbox, parent_id self-reference, and the
-- pinned-knowledge cleanup trigger from migration 239 will all fire normally.
DELETE FROM knowledge_items
WHERE tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Step 3: remove orphaned rows (UUID-shaped tenant_id with no matching tenant).
DELETE FROM knowledge_items ki
WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = ki.tenant_id::uuid);

-- Step 4: drop the existing RLS policy BEFORE altering the column type.
-- Postgres refuses `ALTER COLUMN ... TYPE` when any policy USING / WITH CHECK
-- expression references that column ("cannot alter type of a column used in
-- a policy definition"). Migration 200's DO-loop installed
-- `tenant_isolation_knowledge_items` referencing `tenant_id`; we drop here
-- and re-create at Step 7 with the proper UUID cast.
DROP POLICY IF EXISTS tenant_isolation_knowledge_items ON knowledge_items;

-- Step 5: convert the column type. Postgres will rebuild every index that
-- references tenant_id (three: knowledge_items_tenant_idx,
-- knowledge_items_connector_idx, knowledge_items_external_unique).
ALTER TABLE knowledge_items
  ALTER COLUMN tenant_id TYPE UUID USING tenant_id::uuid;

-- Step 6: add the FK we should have had since migration 183. ON DELETE
-- CASCADE matches the convention in tenants → child tables (e.g., 203's
-- internal_agent_outbox, 240's knowledge_outbox).
ALTER TABLE knowledge_items
  ADD CONSTRAINT knowledge_items_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

-- Step 7: re-create the RLS policy with a UUID cast on the GUC. Migration
-- 200's DO-loop originally installed `tenant_id = current_setting(...)::text`
-- because the column was TEXT at the time. Now that the column is UUID, the
-- policy should compare UUID-to-UUID directly — avoids an implicit cast on
-- every request and matches every other modern policy in the system.
CREATE POLICY tenant_isolation_knowledge_items
  ON knowledge_items
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMIT;
