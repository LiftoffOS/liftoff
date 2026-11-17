-- Enforce: at most one active connector per (tenant_id, type).
-- The tool gateway's connector resolution (src/tool-gateway/service.ts
-- fetchExternalState and executeConnectorCall) relies on this invariant
-- to JOIN connector_manifests -> connectors with
--   ORDER BY c.created_at DESC LIMIT 1
-- and trust the result is the single canonical live connector.
--
-- Without this index, a bug in the reconnect flow could leave two
-- non-disconnected connectors of the same type for the same tenant,
-- and the JOIN would silently pick one — potentially the wrong one.

-- Step 1: Heal pre-existing data violations.
-- An existing database may contain a (tenant_id, type) pair with
-- multiple non-disconnected rows (a reconnect flow without soft-delete
-- can create duplicates). The unique
-- partial index below would fail to build against that data, so we
-- demote all but the most-recently-created row to status 'disconnected'.
-- The most-recently-created row matches what the tool gateway's
-- "ORDER BY created_at DESC LIMIT 1" already returns, so this is a
-- no-op for runtime behavior — it just marks the losers correctly so the
-- index can enforce the invariant going forward.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, type
      ORDER BY created_at DESC, id DESC
    ) AS rn
  FROM connectors
  WHERE status != 'disconnected'
)
UPDATE connectors
SET status = 'disconnected', updated_at = NOW()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Step 2: Create the unique partial index now that the data is clean.
CREATE UNIQUE INDEX IF NOT EXISTS idx_connectors_tenant_type_active
  ON connectors (tenant_id, type)
  WHERE status != 'disconnected';
