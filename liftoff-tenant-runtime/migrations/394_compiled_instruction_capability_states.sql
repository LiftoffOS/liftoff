-- Per-capability live | unwired | absent on the compiled instruction.
--
-- The gateway refuses an `absent` capability's tools BY NAME, and it resolves
-- the map from here rather than from whatever called it. That choice is the
-- whole reason this column exists: ExecuteInput is built at a dozen separate
-- call sites, and a field each one has to remember is a field the next one
-- forgets. Resolved inside the gateway, a new dispatch path inherits the
-- refusal instead of quietly opting out of it.
--
-- Migration 393 may already be applied somewhere, so this is a new file rather
-- than an edit to it: an edited migration runs in no database that already recorded its
-- filename, while a from-scratch rebuild gets the new text.

ALTER TABLE compiled_instructions
  ADD COLUMN IF NOT EXISTS capability_states jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN compiled_instructions.capability_states IS
  'Per-capability live | unwired | absent, sent by the control plane. The tool '
  'gateway reads this to refuse an absent capability''s tools by name.';
