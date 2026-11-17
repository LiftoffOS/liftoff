-- Per-capability live | unwired | absent, on the agent.
--
-- The tri-state exists because two states could not tell "your Slack is down"
-- from "this business has no chat tool and never will", and an agent that
-- cannot tell them apart promises to retry the second forever.
--
-- Stored on the agent rather than only inside decision_record because the
-- RUNTIME needs it: an `absent` capability's tools are refused by name at the
-- gateway, and the gateway resolves the map from the stored instruction rather
-- than from its caller. Keeping it only in the provenance record would leave
-- the enforcing half with nothing to enforce against — which is precisely the
-- state this column is being added to fix.
--
-- Migration 422 may already be applied, so this is a new file rather than an
-- edit to it: an edited migration runs in no database that already recorded
-- its filename, while a from-scratch rebuild gets the new text, and the two
-- disagree forever with nothing comparing them.

ALTER TABLE internal_agents
  ADD COLUMN IF NOT EXISTS capability_states jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN internal_agents.capability_states IS
  'Per-capability live | unwired | absent. `absent` means the platform cannot do '
  'it at all, not that nothing is connected yet; the runtime refuses those tools '
  'by name rather than hiding them.';
