-- 306: invocations.replay_input + rerun_of_invocation_id for "Run again" (ADR-030).
--
-- Failed autonomous runs (cron / event / webhook) can be re-run by a human from
-- the Activity page. To re-run faithfully we must persist the exact input at
-- create time — the invocations row previously stored neither the objective, the
-- structured inputData, nor the trigger, and event-run objectives + payloads are
-- composed at fire time and discarded. `replay_input` captures the run's full
-- re-runnable input; `rerun_of_invocation_id` links a re-run back to the
-- invocation it re-ran (backend attribution only in v1). Both are forward-only and
-- nullable: runs created before this migration have NULL replay_input and are not
-- re-runnable. replay_input is written ONLY for autonomous (cron/event) runs — the
-- only re-runnable ones — so chat/human and delegated/agent runs never populate it.

ALTER TABLE invocations ADD COLUMN IF NOT EXISTS replay_input JSONB NULL;
ALTER TABLE invocations ADD COLUMN IF NOT EXISTS rerun_of_invocation_id UUID NULL;

CREATE INDEX IF NOT EXISTS idx_invocations_rerun_of_invocation_id
  ON invocations (rerun_of_invocation_id) WHERE rerun_of_invocation_id IS NOT NULL;

COMMENT ON COLUMN invocations.replay_input IS
  'ADR-030: full re-runnable input captured at create time — { objective, threadId, triggeredBy, trigger, inputData, chainDepth }. Populated ONLY for autonomous (cron/event) runs (the only re-runnable ones); NULL for chat/human, delegated/agent, and pre-ADR-030 runs. May contain the raw reactive event payload or webhook trigger — the same tenant data already stored in that run''s messages — so it is subject to the invocation retention window and is removed with the invocation (tenant ON DELETE CASCADE); any future PII erasure over messages must also cover this column. Read by the Run again endpoint to re-enqueue a faithful, trust-preserving fresh execution.';

COMMENT ON COLUMN invocations.rerun_of_invocation_id IS
  'ADR-030: when this invocation was produced by "Run again", the id of the original invocation it re-ran. NULL otherwise. Backend attribution/lineage only in v1 (no user-facing surface).';
