-- =============================================================================
-- Action Correction Protocol - Engineering Review Fixes
-- Addresses: BE-002, BE-003, BE-004, BE-011, DE-001-010, SE-010, DE-P2-001-005
-- =============================================================================

-- =============================================================================
-- PART 1: Add self-referential FK on correction_of
-- [BE-002/DE-001] Self-referential FK prevents orphaned correction references
-- =============================================================================

-- [BE-002/DE-001] Self-referential FK with RESTRICT (immutable audit trail)
-- ON DELETE RESTRICT ensures corrections cannot be orphaned
ALTER TABLE agent_audit_logs ADD CONSTRAINT fk_correction_of
  FOREIGN KEY (correction_of) REFERENCES agent_audit_logs(id)
  ON DELETE RESTRICT;

-- [BE-011] Composite partial index for pending correction request lookups
CREATE INDEX idx_agent_audit_pending_corrections ON agent_audit_logs(correction_of, action)
  WHERE correction_of IS NOT NULL AND action IN ('correction_request', 'correction_approved', 'correction_rejected');

-- =============================================================================
-- PART 2: Add enabled column to correction_registry
-- [DE-P2-003] Soft-delete support for registry entries
-- =============================================================================

ALTER TABLE correction_registry ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- [DE-P2-003] Filter by enabled in registry queries
CREATE INDEX idx_correction_registry_enabled ON correction_registry(tool_name) WHERE enabled = TRUE;

-- =============================================================================
-- PART 3: Add timezone column to correction_budgets
-- [DE-P2-001] Tenant timezone for budget periods
-- =============================================================================

ALTER TABLE correction_budgets ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';

-- [DE-P2-001] Valid timezone check
ALTER TABLE correction_budgets ADD CONSTRAINT valid_timezone
  CHECK (timezone ~ '^[A-Za-z_]+/[A-Za-z_]+$' OR timezone = 'UTC');

-- Valid budget_period values
ALTER TABLE correction_budgets ADD CONSTRAINT valid_budget_period
  CHECK (budget_period IN ('daily', 'weekly', 'monthly', 'quarterly', 'yearly'));

-- =============================================================================
-- PART 4: Add constraints and indexes to financial_corrections
-- [BE-003/DE-002/DE-008] FK constraints on audit log references
-- [DE-P2-005] Positive amount constraint
-- =============================================================================

-- [BE-003/DE-002] FK constraint on original_audit_log_id
ALTER TABLE financial_corrections ADD CONSTRAINT fk_original_audit_log
  FOREIGN KEY (original_audit_log_id) REFERENCES agent_audit_logs(id)
  ON DELETE RESTRICT;

-- [DE-008] FK constraint on correction_audit_log_id
ALTER TABLE financial_corrections ADD CONSTRAINT fk_correction_audit_log
  FOREIGN KEY (correction_audit_log_id) REFERENCES agent_audit_logs(id)
  ON DELETE RESTRICT;

-- [DE-P2-005] Prevent negative or zero amounts
ALTER TABLE financial_corrections ADD CONSTRAINT positive_amount
  CHECK (amount_cents > 0);

-- Valid currency codes (ISO 4217)
ALTER TABLE financial_corrections ADD CONSTRAINT valid_currency
  CHECK (currency ~ '^[a-z]{3}$');

-- Index for correction audit log lookups
CREATE INDEX idx_financial_corrections_correction ON financial_corrections(correction_audit_log_id);

-- =============================================================================
-- PART 5: Add tenant index to pending_correction_approvals
-- [DE-009] Index on tenant_id for tenant-scoped queries
-- =============================================================================

CREATE INDEX idx_pending_correction_approvals_tenant ON pending_correction_approvals(tenant_id);

-- Add hitl_level column if missing
ALTER TABLE pending_correction_approvals ADD COLUMN IF NOT EXISTS hitl_level INTEGER NOT NULL DEFAULT 2;

-- =============================================================================
-- PART 6: Add optimized index for tenant rate lookups
-- [DE-P2-004] Optimized index for tenant rate limit lookups
-- =============================================================================

CREATE INDEX idx_correction_rate_usage_tenant ON correction_rate_usage(tenant_id, window_type, window_start DESC);

-- =============================================================================
-- PART 7: Configuration audit trail
-- [DE-P2-002] Track changes to rate limits, budgets, and HITL config
-- =============================================================================

CREATE TABLE correction_config_audit (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  table_name            TEXT NOT NULL,  -- 'correction_rate_limits', 'correction_budgets', 'correction_config'
  changed_by            UUID REFERENCES accounts(id),
  old_values            JSONB,
  new_values            JSONB NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_correction_config_audit_tenant ON correction_config_audit(tenant_id, created_at DESC);

-- Trigger function for config audit logging
CREATE OR REPLACE FUNCTION log_correction_config_change()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO correction_config_audit (tenant_id, table_name, old_values, new_values)
  VALUES (
    COALESCE(NEW.tenant_id, OLD.tenant_id),
    TG_TABLE_NAME,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    to_jsonb(NEW)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply audit triggers
CREATE TRIGGER audit_correction_rate_limits
  AFTER INSERT OR UPDATE ON correction_rate_limits
  FOR EACH ROW EXECUTE FUNCTION log_correction_config_change();

CREATE TRIGGER audit_correction_budgets
  AFTER INSERT OR UPDATE ON correction_budgets
  FOR EACH ROW EXECUTE FUNCTION log_correction_config_change();

CREATE TRIGGER audit_correction_config
  AFTER INSERT OR UPDATE ON correction_config
  FOR EACH ROW EXECUTE FUNCTION log_correction_config_change();
