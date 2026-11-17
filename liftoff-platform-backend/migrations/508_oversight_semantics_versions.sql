-- 508: which meaning of a setting an existing workspace chose.
--
-- The tenant runtime is about to give two oversight settings the meaning the
-- page states: the Escalation setting decides what reaches the review page
-- (surfacing), and "Review for sensitive cases" / "Send automatically when
-- safe" read the message. Both change what a setting an existing workspace
-- ALREADY chose does, and the kills default on, so without a rule an approval
-- requirement could disappear at deploy time.
--
-- The rule: a workspace keeps today's behaviour until it re-saves the setting
-- whose meaning changed. Two columns, one per setting, because one number for
-- both would let a save of Escalation alone switch what Communication means.
-- The update service moves a column to 2 ONLY on a save whose input names its
-- own setting; the new-workspace insert writes 2 for both; the runtime reads
-- an absent or unparseable value as 1.

ALTER TABLE internal_agent_oversight_settings
  ADD COLUMN IF NOT EXISTS escalation_semantics SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS communication_semantics SMALLINT NOT NULL DEFAULT 1;

ALTER TABLE internal_agent_oversight_settings_versions
  ADD COLUMN IF NOT EXISTS escalation_semantics SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS communication_semantics SMALLINT NOT NULL DEFAULT 1;

COMMENT ON COLUMN internal_agent_oversight_settings.escalation_semantics IS
  '1: the Escalation setting means what the code did before 2026-09 (one reader, important equals sensitive). 2: the setting governs surfacing as the page states. Moves to 2 only on a save that names escalation.';
COMMENT ON COLUMN internal_agent_oversight_settings.communication_semantics IS
  '1: Review for sensitive cases pauses on the tool match. 2: a matched message under Review sends when the message check clears it. Moves to 2 only on a save that names communication.';
