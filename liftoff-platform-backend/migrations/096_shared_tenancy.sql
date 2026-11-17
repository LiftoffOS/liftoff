-- Migration 091: Shared tenancy schema
-- Phase 2: Support shared (standard) and dedicated (enterprise) hosting modes
--
-- Standard tier: shared runtime, no GCP project, instant provisioning
-- Enterprise tier: dedicated runtime, own GCP project, minutes to provision

-- Add hosting_mode to distinguish shared vs dedicated tenants
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS hosting_mode VARCHAR(20) NOT NULL DEFAULT 'shared';

-- Add runtime_url for per-tenant runtime endpoint routing
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS runtime_url TEXT;

-- Add tier column if it doesn't exist (was in types.ts but never persisted to DB)
-- Check if column exists first since some deployments may already have it
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tenants' AND column_name = 'tier'
  ) THEN
    ALTER TABLE tenants ADD COLUMN tier VARCHAR(20) NOT NULL DEFAULT 'standard';
  END IF;
END $$;

-- Backfill existing tenants: those with gcp_project_id are dedicated, others are shared
UPDATE tenants
SET hosting_mode = CASE
  WHEN gcp_project_id IS NOT NULL THEN 'dedicated'
  ELSE 'shared'
END
WHERE hosting_mode = 'shared' AND gcp_project_id IS NOT NULL;

-- Index for quick lookup by hosting_mode (used in provisioning and routing)
CREATE INDEX IF NOT EXISTS idx_tenants_hosting_mode ON tenants(hosting_mode);
