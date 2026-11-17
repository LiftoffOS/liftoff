-- Add provider column to invocations
-- Enables cost recomputation from tokens alone without relying on snapshot cost_usd.
-- Provider is needed alongside model_id to look up the correct pricing rate.

ALTER TABLE invocations ADD COLUMN provider TEXT;

-- Backfill existing rows using llm_usage_log where available (most accurate).
-- Falls back to 'anthropic-vertex' which is the default provider for tenant runtimes.
UPDATE invocations i
SET provider = COALESCE(
  (SELECT l.provider FROM llm_usage_log l WHERE l.invocation_id = i.id::text LIMIT 1),
  'anthropic-vertex'
)
WHERE i.provider IS NULL;

-- Now enforce NOT NULL for all future inserts
ALTER TABLE invocations ALTER COLUMN provider SET NOT NULL;

-- Add CHECK constraint matching LLMProvider type
ALTER TABLE invocations ADD CONSTRAINT chk_invocations_provider
  CHECK (provider IN ('anthropic', 'anthropic-vertex', 'google', 'openai'));

COMMENT ON COLUMN invocations.provider IS 'LLM provider used for this invocation (anthropic, anthropic-vertex, google, openai).';
