-- =============================================================================
-- Action Correction Protocol
-- Enterprise-grade forward correction system for autonomous agent actions
-- =============================================================================

-- =============================================================================
-- PART 1: Extend agent_audit_logs with correction linking
-- =============================================================================

-- Add column to link correction actions to original actions
-- This enables querying the full audit trail including corrections
ALTER TABLE agent_audit_logs ADD COLUMN correction_of UUID;

-- Index for efficient lookups: "was this action corrected?" and "get correction history"
CREATE INDEX idx_agent_audit_correction_of ON agent_audit_logs(correction_of) WHERE correction_of IS NOT NULL;

COMMENT ON COLUMN agent_audit_logs.correction_of IS
  'Links this audit log to the original action it corrects. NULL for original actions. Creates immutable audit trail.';

-- =============================================================================
-- PART 2: Correction registry (action → correction_action configuration)
-- =============================================================================

-- Correction types - how an action can be corrected
CREATE TYPE correction_type AS ENUM (
  'archive',        -- Archive/soft-delete the created resource
  'amend',          -- Update to previous state with amendment record
  'delete',         -- Hard delete (time-limited, e.g., Slack)
  'refund',         -- Financial compensation (creates new transaction)
  'credit',         -- Apply credit instead of refund
  'void',           -- Void transaction (if not yet settled)
  'follow_up',      -- Send correction/follow-up communication
  'not_correctable' -- Explicitly mark as not correctable
);

-- Correction registry: defines which actions can be corrected and how
CREATE TABLE correction_registry (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name             TEXT NOT NULL UNIQUE,
  integration_type      TEXT NOT NULL,
  correction_tool_name  TEXT,  -- NULL for not_correctable actions
  correction_type       correction_type NOT NULL DEFAULT 'not_correctable',
  time_window_seconds   INTEGER,  -- For time-limited corrections (e.g., Slack delete)
  requires_previous_state BOOLEAN NOT NULL DEFAULT FALSE,  -- Needs pre-action snapshot for amend
  user_facing_label     TEXT,  -- e.g., "Archive issue", "Issue refund", "Cannot be corrected"
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_time_window CHECK (
    (time_window_seconds IS NULL OR time_window_seconds > 0)
  )
);

CREATE INDEX idx_correction_registry_integration ON correction_registry(integration_type);
CREATE INDEX idx_correction_registry_type ON correction_registry(correction_type);

COMMENT ON TABLE correction_registry IS
  'Action → correction mapping. Defines which actions can be corrected and the correction mechanism.';

-- =============================================================================
-- PART 3: Seed correction mappings with user-facing labels
-- =============================================================================

INSERT INTO correction_registry (tool_name, integration_type, correction_tool_name, correction_type, time_window_seconds, requires_previous_state, user_facing_label) VALUES
  -- Gmail - Most email actions are not correctable
  ('gmail_send_email', 'gmail', NULL, 'not_correctable', NULL, FALSE, 'Sent emails cannot be recalled'),
  ('gmail_create_draft', 'gmail', 'gmail_delete_draft', 'delete', NULL, FALSE, 'Delete draft'),
  ('gmail_delete_email', 'gmail', NULL, 'not_correctable', NULL, FALSE, 'Deleted emails cannot be recovered'),
  ('gmail_modify_labels', 'gmail', 'gmail_modify_labels', 'amend', NULL, TRUE, 'Restore original labels'),

  -- Slack - Messages can be deleted within time window
  ('slack_send_message', 'slack', 'slack_delete_message', 'delete', 3600, FALSE, 'Delete message (within 1 hour)'),
  ('slack_update_message', 'slack', 'slack_update_message', 'amend', NULL, TRUE, 'Restore previous content'),
  ('slack_delete_message', 'slack', NULL, 'not_correctable', NULL, FALSE, 'Deleted messages cannot be recovered'),
  ('slack_create_channel', 'slack', 'slack_archive_channel', 'archive', NULL, FALSE, 'Archive channel'),

  -- Stripe - Financial corrections via refund/void
  ('stripe_create_charge', 'stripe', 'stripe_create_refund', 'refund', NULL, FALSE, 'Issue refund'),
  ('stripe_create_subscription', 'stripe', 'stripe_cancel_subscription', 'void', NULL, FALSE, 'Cancel subscription'),
  ('stripe_update_subscription', 'stripe', 'stripe_update_subscription', 'amend', NULL, TRUE, 'Restore previous subscription'),

  -- Linear - Issues can be archived or amended
  ('linear_create_issue', 'linear', 'linear_archive_issue', 'archive', NULL, FALSE, 'Archive issue'),
  ('linear_update_issue', 'linear', 'linear_update_issue', 'amend', NULL, TRUE, 'Restore previous state'),
  ('linear_delete_issue', 'linear', NULL, 'not_correctable', NULL, FALSE, 'Deleted issues cannot be recovered'),

  -- Notion - Pages can be archived or amended
  ('notion_create_page', 'notion', 'notion_archive_page', 'archive', NULL, FALSE, 'Archive page'),
  ('notion_update_page', 'notion', 'notion_update_page', 'amend', NULL, TRUE, 'Restore previous version'),
  ('notion_delete_page', 'notion', NULL, 'not_correctable', NULL, FALSE, 'Deleted pages cannot be recovered')
ON CONFLICT (tool_name) DO NOTHING;

-- =============================================================================
-- PART 4: HITL configuration for corrections
-- =============================================================================

-- Add HITL columns to registry
ALTER TABLE correction_registry ADD COLUMN requires_hitl_approval BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE correction_registry ADD COLUMN hitl_level INTEGER DEFAULT 2;
ALTER TABLE correction_registry ADD COLUMN max_correction_chain INTEGER NOT NULL DEFAULT 3;

-- Tenant-level correction config
CREATE TABLE correction_config (
  tenant_id                 UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  require_approval_all      BOOLEAN NOT NULL DEFAULT FALSE,
  auto_approve_window       INTEGER,  -- Auto-approve if correction within X seconds of original
  require_original_actor    BOOLEAN NOT NULL DEFAULT FALSE,  -- Only original actor can correct
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- PART 5: Rate limiting for corrections
-- =============================================================================

CREATE TABLE correction_rate_limits (
  tenant_id             UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  max_per_minute        INTEGER NOT NULL DEFAULT 10,
  max_per_hour          INTEGER NOT NULL DEFAULT 100,
  max_per_day           INTEGER NOT NULL DEFAULT 500,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE correction_rate_usage (
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  window_start          TIMESTAMPTZ NOT NULL,
  window_type           TEXT NOT NULL,  -- 'minute', 'hour', 'day'
  count                 INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, window_start, window_type)
);

CREATE INDEX idx_correction_rate_usage_cleanup ON correction_rate_usage(window_start);

-- =============================================================================
-- PART 6: Correction budgets
-- =============================================================================

CREATE TABLE correction_budgets (
  tenant_id             UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  budget_limit          INTEGER,  -- NULL = unlimited
  budget_used           INTEGER NOT NULL DEFAULT 0,
  budget_period         TEXT NOT NULL DEFAULT 'monthly',
  period_start          TIMESTAMPTZ NOT NULL DEFAULT DATE_TRUNC('month', NOW()),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- PART 7: Financial corrections (for CFO audit compliance)
-- =============================================================================

CREATE TABLE financial_corrections (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  original_audit_log_id UUID NOT NULL,
  correction_audit_log_id UUID NOT NULL,
  correction_type       correction_type NOT NULL,
  amount_cents          INTEGER NOT NULL,
  currency              TEXT NOT NULL DEFAULT 'usd',
  reason                TEXT NOT NULL,
  reconciled            BOOLEAN NOT NULL DEFAULT FALSE,
  reconciled_at         TIMESTAMPTZ,
  reconciled_by         UUID REFERENCES accounts(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_financial_corrections_tenant ON financial_corrections(tenant_id);
CREATE INDEX idx_financial_corrections_unreconciled ON financial_corrections(reconciled) WHERE reconciled = FALSE;
CREATE INDEX idx_financial_corrections_audit ON financial_corrections(original_audit_log_id);

COMMENT ON TABLE financial_corrections IS
  'Tracks financial corrections (refunds, credits, voids) for CFO audit compliance and reconciliation.';

-- =============================================================================
-- PART 8: Pending correction approvals (for HITL-gated corrections)
-- =============================================================================

CREATE TABLE pending_correction_approvals (
  correction_request_id   UUID PRIMARY KEY,
  feedback_id             UUID NOT NULL UNIQUE,
  tenant_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  original_audit_log_id   UUID NOT NULL,
  correction_tool_name    TEXT NOT NULL,
  correction_type         correction_type NOT NULL,
  requires_previous_state BOOLEAN NOT NULL DEFAULT FALSE,
  reason                  TEXT,
  requested_by            UUID NOT NULL REFERENCES accounts(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at              TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_pending_correction_approvals_feedback ON pending_correction_approvals(feedback_id);
CREATE INDEX idx_pending_correction_approvals_expires ON pending_correction_approvals(expires_at);

COMMENT ON TABLE pending_correction_approvals IS
  'Temporary storage for correction requests awaiting HITL approval. Cleaned up on approval, rejection, or expiration.';
