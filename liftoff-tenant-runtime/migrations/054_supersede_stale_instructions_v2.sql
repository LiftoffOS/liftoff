-- Supersede all active compiled instructions so the next activation
-- creates a fresh one with corrected integration UUIDs.
-- This is safe because activation always creates a new instruction
-- when no active one exists.
UPDATE compiled_instructions
SET status = 'superseded', activated_at = NULL, updated_at = NOW()
WHERE status = 'active';
