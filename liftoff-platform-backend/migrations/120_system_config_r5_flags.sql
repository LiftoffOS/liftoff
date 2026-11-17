-- system_config flags (platform-backend mirror of tenant-runtime migration 089).
-- Idempotent — TR also migrates the same table. PB is the source of truth
-- for cross-service flags (awaiting_input_emission_enabled, chat_turn_globally_disabled).

CREATE TABLE IF NOT EXISTS system_config (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1)
);
INSERT INTO system_config (id) VALUES (1) ON CONFLICT DO NOTHING;

ALTER TABLE system_config
  ADD COLUMN IF NOT EXISTS awaiting_input_emission_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS chat_turn_globally_disabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN system_config.awaiting_input_emission_enabled IS
  'Gates awaiting_input SSE emission.';
COMMENT ON COLUMN system_config.chat_turn_globally_disabled IS
  'Emergency kill switch for SDK contract failures.';
