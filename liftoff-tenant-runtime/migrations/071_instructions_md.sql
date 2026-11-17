ALTER TABLE agents                ADD COLUMN IF NOT EXISTS instructions_md TEXT;
ALTER TABLE compiled_instructions ADD COLUMN IF NOT EXISTS instructions_md TEXT;
