-- Migration 081: Tool Classification Extensions for MCP Connector Migration
-- Adds reviewed_by, is_manual_override, and tenant_id columns
-- Per MCP Connector Migration Plan Phase 0.3

-- reviewed_by: must be non-null before LLM-assigned categories are trusted (SE-001)
ALTER TABLE tool_classification_cache ADD COLUMN IF NOT EXISTS reviewed_by TEXT;

-- is_manual_override: manual overrides take precedence over LLM classification
ALTER TABLE tool_classification_cache ADD COLUMN IF NOT EXISTS is_manual_override BOOLEAN DEFAULT false;

-- tenant_id: nullable = global default; non-null = tenant-specific override (SE-008)
-- Lookup order: tenant-specific first, then global
ALTER TABLE tool_classification_cache ADD COLUMN IF NOT EXISTS tenant_id TEXT;

-- The original PK is (tool_name). We need to allow the same tool_name with different
-- tenant_ids (global + per-tenant overrides). Drop the old PK and replace with a
-- unique index that treats NULL tenant_id as a distinct value via COALESCE.
-- PostgreSQL doesn't allow expressions in PRIMARY KEY constraints, so we use a
-- UNIQUE INDEX instead, which provides the same constraint enforcement.
ALTER TABLE tool_classification_cache DROP CONSTRAINT IF EXISTS tool_classification_cache_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS tool_classification_cache_pkey
  ON tool_classification_cache (tool_name, COALESCE(tenant_id, '__global__'));

-- Index for tenant-specific lookups
CREATE INDEX IF NOT EXISTS idx_tool_classification_tenant
  ON tool_classification_cache(tenant_id) WHERE tenant_id IS NOT NULL;

-- Index for finding unreviewed classifications
CREATE INDEX IF NOT EXISTS idx_tool_classification_unreviewed
  ON tool_classification_cache(reviewed_by) WHERE reviewed_by IS NULL;

COMMENT ON COLUMN tool_classification_cache.reviewed_by IS 'Who reviewed this classification. Null = unreviewed (fail-secure: most restrictive categories apply)';
COMMENT ON COLUMN tool_classification_cache.is_manual_override IS 'True if categories were manually set (takes precedence over LLM)';
COMMENT ON COLUMN tool_classification_cache.tenant_id IS 'Null = global default. Non-null = tenant-specific override (can only be stricter than global)';
