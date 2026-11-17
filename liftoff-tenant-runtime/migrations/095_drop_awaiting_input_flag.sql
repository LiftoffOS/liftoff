-- Drop awaiting_input_emission_enabled from system_config.
-- No code path reads this column; output sanitisation does not depend on it.
-- chat_turn_globally_disabled is kept; it's the legitimate emergency kill switch.

ALTER TABLE system_config
  DROP COLUMN IF EXISTS awaiting_input_emission_enabled;
