-- Drop the push_high_risk_allowed column added by migration 088.
-- workspace_git_push and its tool family are removed in this release;
-- no remaining code path reads this column. v5 redistill-parity sweep.
ALTER TABLE compiled_instructions DROP COLUMN IF EXISTS push_high_risk_allowed;
