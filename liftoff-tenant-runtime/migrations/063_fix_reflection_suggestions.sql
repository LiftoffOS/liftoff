-- Fix reflection_suggestions table: add columns expected by service code
-- (recordSuggestionOutcome at service.ts line 287 expects these columns)
ALTER TABLE reflection_suggestions ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;
ALTER TABLE reflection_suggestions ADD COLUMN IF NOT EXISTS applied_by TEXT;
ALTER TABLE reflection_suggestions ADD COLUMN IF NOT EXISTS effective_measure TEXT;
ALTER TABLE reflection_suggestions ADD COLUMN IF NOT EXISTS feedback TEXT;
