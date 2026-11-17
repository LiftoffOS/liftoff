-- cache_read_input_tokens from the Anthropic API was captured by the SDK engine
-- but had no column to land in — it was dropped in hooks-builder before this.
ALTER TABLE invocations ADD COLUMN IF NOT EXISTS cached_tokens INTEGER NOT NULL DEFAULT 0;
