-- "What have I produced before?", asked without already knowing the answer.
--
-- `idx_actions_target_lookup` (migration 373) answers "have I acted on THIS
-- target", and it is the right index for that: target_ref is the second
-- equality column, so a caller who names the target gets a handful of rows.
--
-- It cannot answer the question underneath it. An agent asking whether it has
-- already written a battle card for a competitor does not hold the document's
-- id — finding that id IS the question. With target_ref in the middle of the
-- key, "this agent, most recent first" cannot use the index at all and falls
-- back to a scan of everything the tenant ever dispatched.
--
-- Without it, an agent searching a document store by keyword for work it made
-- itself can match nothing and report that no battle card exists for a
-- competitor while one does, though its own ledger rows are in this table.
--
-- Partial on external writes, for the same reason 373 is partial on a non-empty
-- target: a read can never be an artifact this agent produced, and reads are
-- the bulk of the table. The index stays proportional to the rows that can
-- answer the question.
CREATE INDEX IF NOT EXISTS idx_actions_agent_recency
  ON actions (tenant_id, agent_id, created_at DESC)
  WHERE is_external_write = true;
