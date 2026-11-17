-- Migration 010: Align kill_switches schema with admission service code.
--
-- Migration 001 created kill_switches with a (switch_name, state) design.
-- The admission service code (src/admission/service.ts) was written against
-- a different schema: (switch_type, enabled, agent_id, connector_type,
-- reason, expires_at). This mismatch causes every Preflight call to fail
-- with a PostgreSQL "column does not exist" error, returning HTTP 500.
--
-- Data migration strategy for existing rows:
--   switch_name  → switch_type
--   state='on'   → enabled=true
--   state='off'  → enabled=false (default)
--   tenant_id='__global__' → tenant_id=NULL (new representation of global rows)
-- In practice the table starts empty; the conversion is defensive.

-- Step 1: Add new UUID primary key (nullable until populated).
ALTER TABLE kill_switches ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();
UPDATE kill_switches SET id = gen_random_uuid() WHERE id IS NULL;
ALTER TABLE kill_switches ALTER COLUMN id SET NOT NULL;

-- Step 2: Drop old composite PK so we can add the new one.
ALTER TABLE kill_switches DROP CONSTRAINT IF EXISTS kill_switches_pkey;
ALTER TABLE kill_switches ADD PRIMARY KEY (id);

-- Step 3: Add new columns needed by admission service.
ALTER TABLE kill_switches
  ADD COLUMN IF NOT EXISTS switch_type  TEXT,
  ADD COLUMN IF NOT EXISTS enabled      BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS reason       TEXT,
  ADD COLUMN IF NOT EXISTS agent_id     TEXT,
  ADD COLUMN IF NOT EXISTS connector_type TEXT,
  ADD COLUMN IF NOT EXISTS expires_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Step 4: Migrate existing data from old columns to new.
UPDATE kill_switches
SET switch_type = switch_name,
    enabled     = (state = 'on')
WHERE switch_type IS NULL;

-- Step 5: Convert '__global__' sentinel rows to NULL tenant_id.
--   The new code queries: tenant_id IS NULL OR tenant_id = $1
--   The old schema used tenant_id='__global__' to represent global rows.
ALTER TABLE kill_switches ALTER COLUMN tenant_id DROP NOT NULL;
UPDATE kill_switches SET tenant_id = NULL WHERE tenant_id = '__global__';

-- Step 6: Enforce NOT NULL on switch_type now that all rows are populated.
ALTER TABLE kill_switches ALTER COLUMN switch_type SET NOT NULL;

-- Step 7: Remove old columns.
ALTER TABLE kill_switches DROP COLUMN IF EXISTS switch_name;
ALTER TABLE kill_switches DROP COLUMN IF EXISTS state;

-- Step 8: Update RLS policies to match new schema.
--   Old: tenant_id='__global__' was the global sentinel.
--   New: tenant_id IS NULL means global; tenant rows have a TEXT tenant_id.
DROP POLICY IF EXISTS kill_switches_visibility ON kill_switches;
DROP POLICY IF EXISTS kill_switches_write      ON kill_switches;

CREATE POLICY kill_switches_visibility ON kill_switches
  FOR SELECT
  USING (
    tenant_id IS NULL
    OR tenant_id = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY kill_switches_write ON kill_switches
  FOR ALL
  USING     (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- Step 9: Add indexes for the query patterns in admission service.
CREATE INDEX IF NOT EXISTS idx_kill_switches_tenant_type
  ON kill_switches (tenant_id, switch_type)
  WHERE enabled = true;
