-- system_config flags
-- awaiting_input_emission_enabled: gates frontend awaiting_input SSE events.
--   Enable only once the frontend sanitises the rendered content.
-- chat_turn_globally_disabled: emergency kill switch for SDK contract failures.
--   Set true by an operator to stop all chat turns.

-- system_config table is expected to exist (single-row config); create if absent.
CREATE TABLE IF NOT EXISTS system_config (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1)
);
INSERT INTO system_config (id) VALUES (1) ON CONFLICT DO NOTHING;

ALTER TABLE system_config
  ADD COLUMN IF NOT EXISTS awaiting_input_emission_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS chat_turn_globally_disabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN system_config.awaiting_input_emission_enabled IS
  'Gates awaiting_input SSE event emission. OFF by default.';
COMMENT ON COLUMN system_config.chat_turn_globally_disabled IS
  'Emergency kill switch. When TRUE, all chat turns return 503.';
