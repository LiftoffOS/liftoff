-- Add engine_config column to agents table for execution engine selection.
-- NULL = custom-loop (default). Set to {"type":"claude-sdk"} to use SDK engine.
-- Per deployment ordering: this migration must run BEFORE code that reads engine_config.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS engine_config JSONB DEFAULT NULL;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS delegates JSONB DEFAULT '[]'::jsonb;
COMMENT ON COLUMN agents.engine_config IS 'Engine selection. NULL = custom-loop (default).';
COMMENT ON COLUMN agents.delegates IS 'Delegate agent configs for agent-to-agent collaboration.';
