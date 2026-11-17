-- Add FK CASCADE on knowledge_items.connector_id → connectors.id.
--
-- Migration 183 created knowledge_items.connector_id as TEXT NULL with no
-- foreign key. Result: deleting a connector silently orphans every
-- knowledge_items row that referenced it. corpus_search filters retrieval
-- by the agent's bound connector IDs, so orphans become invisible to
-- every agent — the content stays in the DB but no agent can ever read
-- it, no error is surfaced, and the operator's reaction is "Help Center
-- is empty" (because that's literally what every agent sees, even though
-- the rows exist).
--
-- Fix:
--   1. Delete existing orphans (no matching connector — they're already
--      unreachable from every agent path, this just makes the DB honest).
--   2. Convert connector_id TEXT → UUID. Migration 183 stored UUIDs as
--      TEXT, which prevents adding a typed FK.
--   3. Add FK with ON DELETE CASCADE so future connector deletes clean
--      up dependent knowledge_items automatically (matches every other
--      connector_id reference in migration 013: connector_credentials,
--      connector_sync_stats, connector_health_metrics, etc. — all of
--      which already CASCADE).
--
-- NULL connector_id (manually-uploaded knowledge not tied to a connector)
-- remains allowed; FK CASCADE only fires on non-NULL values.

BEGIN;

-- Step 1: clean orphans. NULL connector_id is fine (no FK constraint
-- to satisfy); only non-NULL values that don't map to a live connector
-- get dropped.
DELETE FROM knowledge_items
WHERE connector_id IS NOT NULL
  AND connector_id NOT IN (SELECT id::text FROM connectors);

-- Step 2: convert column type. Defensively wrap in a CASE so any
-- legacy non-UUID string (shouldn't exist after step 1, but be safe)
-- coerces to NULL rather than aborting the migration.
ALTER TABLE knowledge_items
  ALTER COLUMN connector_id TYPE UUID
  USING CASE
    WHEN connector_id IS NULL THEN NULL
    WHEN connector_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN connector_id::UUID
    ELSE NULL
  END;

-- Step 3: add FK with ON DELETE CASCADE. Matches every other
-- connector_id reference in migration 013.
ALTER TABLE knowledge_items
  ADD CONSTRAINT knowledge_items_connector_id_fkey
  FOREIGN KEY (connector_id) REFERENCES connectors(id) ON DELETE CASCADE;

COMMIT;
