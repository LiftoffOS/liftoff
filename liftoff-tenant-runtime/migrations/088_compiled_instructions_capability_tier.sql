-- capability_tier + push_high_risk_allowed on compiled_instructions
-- Capability tier gates tool availability (connector_only | execution_enabled).
-- push_high_risk_allowed is a per-agent flag that gates workspace_git_push.
-- Distillation MUST NOT auto-set push flag (enforced in Fix 10 distill-service).

ALTER TABLE compiled_instructions
  ADD COLUMN IF NOT EXISTS capability_tier VARCHAR(32) NOT NULL DEFAULT 'connector_only'
    CHECK (capability_tier IN ('connector_only', 'execution_enabled')),
  ADD COLUMN IF NOT EXISTS push_high_risk_allowed BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN compiled_instructions.capability_tier IS
  'connector_only (read-only + connectors) or execution_enabled (+Write/Edit/workspace_*)';
COMMENT ON COLUMN compiled_instructions.push_high_risk_allowed IS
  'Gates workspace_git_push. Never auto-set by distillation. Changed via authenticated agent-config path.';
