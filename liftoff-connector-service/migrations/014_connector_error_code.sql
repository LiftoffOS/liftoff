-- Per-instance error code captured at the moment a connector transitions
-- to status='error' so the resolver can short-circuit (no vendor round-trip)
-- and the runtime can surface the right user message via the tool_result
-- envelope. NULL when status != 'error'.

ALTER TABLE connectors
  ADD COLUMN error_code TEXT NULL
    CHECK (error_code IS NULL OR error_code IN ('byok_insufficient_funds', 'byok_invalid_key'));

CREATE INDEX idx_connectors_error_code
  ON connectors (tenant_id, error_code)
  WHERE error_code IS NOT NULL;
