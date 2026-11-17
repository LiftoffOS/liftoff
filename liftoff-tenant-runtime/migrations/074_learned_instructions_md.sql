-- Runtime-generated CLAUDE.md amendments from the slow loop.
-- Separate from backend-published instructions_md (never overwritten by Pub/Sub events).

ALTER TABLE compiled_instructions ADD COLUMN IF NOT EXISTS learned_instructions_md TEXT;
ALTER TABLE compiled_instructions ADD COLUMN IF NOT EXISTS last_amendment_audit_id UUID;
