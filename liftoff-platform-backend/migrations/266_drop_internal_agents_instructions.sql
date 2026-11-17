-- Drop internal_agents.instructions + internal_agent_versions.instructions.
--
-- Added by migration 161 for codex-agent-sdk agents. The codex engine is
-- unused and the entire consumer chain is dead at five points:
--   1. distill LLM never emits `instructions` for any non-codex agent, so
--      the columns hold no non-NULL values.
--   2. PB stores it via service.ts but the column is always NULL.
--   3. event-payload.ts published it to TR; TR subscriber's
--      createAndActivateForInternalAgent never threaded it into the
--      instruction compiler call.
--   4. compiled_instructions.instructions_text in TR was always NULL.
--   5. TR buildSystemPrompt's isCodex branch was the only consumer, gated
--      on engineType='codex-agent-sdk' which no caller ever passed —
--      structurally unreachable.
--
-- Code reading/writing these columns is removed in the same change set.
-- Drop is irreversible but loses no data.
ALTER TABLE internal_agents          DROP COLUMN IF EXISTS instructions;
ALTER TABLE internal_agent_versions  DROP COLUMN IF EXISTS instructions;
