-- Supersede all active instructions to force fresh creation on next activation.
-- Migration 074 on the platform backend fixed integration references.
UPDATE compiled_instructions
SET status = 'superseded', activated_at = NULL, updated_at = NOW()
WHERE status = 'active';
