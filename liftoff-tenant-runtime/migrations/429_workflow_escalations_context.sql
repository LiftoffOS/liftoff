-- 429: why an escalation landed where it did, on the row.
--
-- The ask check (agent-execution/engine/ask-check.ts) reads a customer-facing
-- escalation before it posts, and when nobody in the workspace can act on it
-- the row is written as a system_internal operator record instead. The row
-- has to say that this is what happened and how sure the check was, the way
-- an approval row's `context` says why a person was asked. `resolution` is
-- written at resolve time and is the wrong column for a fact about the
-- creation. Nullable: every existing writer leaves it NULL.
ALTER TABLE workflow_escalations
  ADD COLUMN IF NOT EXISTS context JSONB;

COMMENT ON COLUMN workflow_escalations.context IS
  'Why the escalation landed on this surface, written at creation. ask_check = { person_can_act: p } when the ask check moved a customer-facing escalation to an operator record. NULL on every other row.';
