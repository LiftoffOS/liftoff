-- Migration 242: finish the knowledge-domain tenant_id TEXT → UUID conversion.
--
-- Migration 241 fixed knowledge_items.tenant_id. This migration cleans up the
-- remaining knowledge-domain tables that still carry the same legacy TEXT
-- shape, so the whole module is consistent before any new readers/writers
-- come online.
--
-- Tables touched:
--   1. knowledge_webhook_subscriptions  (migration 189) — TEXT → UUID + FK
--   2. knowledge_item_chunks            (migration 238) — TEXT → UUID + FK
--   3. pinned_knowledge_backfill_report (migration 239) — TEXT → UUID + FK
--
-- Also fixes a pre-existing RLS bug:
--   Migration 238 created `knowledge_item_chunks_tenant_isolation` referencing
--   `current_setting('app.tenant_id')`, but the application sets
--   `app.current_tenant_id` (see src/infrastructure/database.ts:177). The
--   policy currently never matches because the GUC it reads is never set;
--   queries only work today because RLS isn't FORCEd and the table owner
--   bypasses it. Once FORCE RLS rolls out this would
--   start blocking every query. Drop the broken policy and create a correctly-
--   named one matching the convention from migration 200.
--
-- All three tables are written exclusively by the application or background
-- jobs, both of which already source tenant_id from a UUID-typed parent
-- (request middleware JWT, or internal_agents.tenant_id). The defensive
-- DELETEs below should find zero rows in well-maintained environments; they
-- exist to prevent the ALTER TYPE / ADD FK from crashing on any unexpected
-- legacy data.

BEGIN;

-- ============================================================================
-- 1. knowledge_webhook_subscriptions
-- ============================================================================

DO $$
DECLARE
  bad_format_count INT;
  orphan_count INT;
BEGIN
  SELECT COUNT(*) INTO bad_format_count
  FROM knowledge_webhook_subscriptions
  WHERE tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  IF bad_format_count > 0 THEN
    RAISE NOTICE 'Migration 242: deleting % knowledge_webhook_subscriptions rows with non-UUID tenant_id', bad_format_count;
  END IF;

  SELECT COUNT(*) INTO orphan_count
  FROM knowledge_webhook_subscriptions kws
  WHERE kws.tenant_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = kws.tenant_id::uuid);
  IF orphan_count > 0 THEN
    RAISE NOTICE 'Migration 242: deleting % knowledge_webhook_subscriptions rows orphaned from tenants', orphan_count;
  END IF;
END$$;

DELETE FROM knowledge_webhook_subscriptions
WHERE tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

DELETE FROM knowledge_webhook_subscriptions kws
WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = kws.tenant_id::uuid);

-- Drop the existing RLS policy BEFORE altering the column type. Postgres
-- refuses `ALTER COLUMN ... TYPE` when any policy expression references the
-- column ("cannot alter type of a column used in a policy definition").
DROP POLICY IF EXISTS tenant_isolation_knowledge_webhook_subscriptions ON knowledge_webhook_subscriptions;

ALTER TABLE knowledge_webhook_subscriptions
  ALTER COLUMN tenant_id TYPE UUID USING tenant_id::uuid;

ALTER TABLE knowledge_webhook_subscriptions
  ADD CONSTRAINT knowledge_webhook_subscriptions_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

-- Re-create the RLS policy with the proper UUID cast (migration 200's DO-loop
-- installed a `::text` cast because the column was TEXT at the time).
CREATE POLICY tenant_isolation_knowledge_webhook_subscriptions
  ON knowledge_webhook_subscriptions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ============================================================================
-- 2. knowledge_item_chunks (also fixes the broken RLS policy from 238)
-- ============================================================================

DO $$
DECLARE
  bad_format_count INT;
  orphan_count INT;
BEGIN
  SELECT COUNT(*) INTO bad_format_count
  FROM knowledge_item_chunks
  WHERE tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  IF bad_format_count > 0 THEN
    RAISE NOTICE 'Migration 242: deleting % knowledge_item_chunks rows with non-UUID tenant_id', bad_format_count;
  END IF;

  -- Migration 241 already CASCADE-deleted any knowledge_item_chunks whose
  -- parent knowledge_items.tenant_id failed conversion. This catches any
  -- chunks whose tenant_id drifted from the parent independently.
  SELECT COUNT(*) INTO orphan_count
  FROM knowledge_item_chunks kic
  WHERE kic.tenant_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = kic.tenant_id::uuid);
  IF orphan_count > 0 THEN
    RAISE NOTICE 'Migration 242: deleting % knowledge_item_chunks rows orphaned from tenants', orphan_count;
  END IF;
END$$;

DELETE FROM knowledge_item_chunks
WHERE tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

DELETE FROM knowledge_item_chunks kic
WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = kic.tenant_id::uuid);

-- Drop BOTH possible policy names before the type change. Migration 238
-- installed `knowledge_item_chunks_tenant_isolation` (broken — references
-- the wrong `app.tenant_id` GUC); migration 200's DO-loop did not touch this
-- table because the table didn't exist yet, but we drop the convention name
-- defensively. Both must be gone before `ALTER COLUMN ... TYPE` can run.
DROP POLICY IF EXISTS knowledge_item_chunks_tenant_isolation ON knowledge_item_chunks;
DROP POLICY IF EXISTS tenant_isolation_knowledge_item_chunks ON knowledge_item_chunks;

ALTER TABLE knowledge_item_chunks
  ALTER COLUMN tenant_id TYPE UUID USING tenant_id::uuid;

ALTER TABLE knowledge_item_chunks
  ADD CONSTRAINT knowledge_item_chunks_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

-- Install the correct policy (replaces 238's broken one that referenced the
-- wrong GUC name — `app.tenant_id` vs the application's `app.current_tenant_id`).
CREATE POLICY tenant_isolation_knowledge_item_chunks
  ON knowledge_item_chunks
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ============================================================================
-- 3. pinned_knowledge_backfill_report
-- ============================================================================
-- Operator audit table, no RLS (written from a background job that uses the
-- raw pool, intentional — see backfill-pinned-knowledge.ts). Convert the
-- column for type consistency only; no policy work.

DO $$
DECLARE
  bad_format_count INT;
  orphan_count INT;
BEGIN
  SELECT COUNT(*) INTO bad_format_count
  FROM pinned_knowledge_backfill_report
  WHERE tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  IF bad_format_count > 0 THEN
    RAISE NOTICE 'Migration 242: deleting % pinned_knowledge_backfill_report rows with non-UUID tenant_id', bad_format_count;
  END IF;

  SELECT COUNT(*) INTO orphan_count
  FROM pinned_knowledge_backfill_report pkbr
  WHERE pkbr.tenant_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = pkbr.tenant_id::uuid);
  IF orphan_count > 0 THEN
    RAISE NOTICE 'Migration 242: deleting % pinned_knowledge_backfill_report rows orphaned from tenants', orphan_count;
  END IF;
END$$;

DELETE FROM pinned_knowledge_backfill_report
WHERE tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

DELETE FROM pinned_knowledge_backfill_report pkbr
WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = pkbr.tenant_id::uuid);

ALTER TABLE pinned_knowledge_backfill_report
  ALTER COLUMN tenant_id TYPE UUID USING tenant_id::uuid;

ALTER TABLE pinned_knowledge_backfill_report
  ADD CONSTRAINT pinned_knowledge_backfill_report_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

-- ============================================================================
-- 4. Cleanup: the explicit ::uuid cast in the pinned-knowledge cleanup trigger
-- ============================================================================
-- Migration 239 added `OLD.tenant_id::uuid` to bridge knowledge_items.tenant_id
-- (TEXT) → internal_agents.tenant_id (UUID). Now that 241 made both columns
-- UUID, the cast is redundant. Re-create the function without it for clarity.
CREATE OR REPLACE FUNCTION cleanup_pinned_knowledge_on_delete()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE internal_agents
     SET pinned_knowledge_ids = array_remove(pinned_knowledge_ids, OLD.id)
   WHERE tenant_id = OLD.tenant_id
     AND pinned_knowledge_ids && ARRAY[OLD.id];
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

COMMIT;
