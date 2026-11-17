-- Drop feature flag columns that were never needed.
--
-- chat_sdk_mode: per-tenant flag gating SDK vs legacy LLM loop. SDK is now
-- always active; the flag only served to block agents from using working code.
--
-- awaiting_input_emission_enabled: gated awaiting_input SSE events on React
-- shipping DOMPurify. No code path reads the flag.

ALTER TABLE tenants
  DROP COLUMN IF EXISTS chat_sdk_mode;

ALTER TABLE system_config
  DROP COLUMN IF EXISTS awaiting_input_emission_enabled;
