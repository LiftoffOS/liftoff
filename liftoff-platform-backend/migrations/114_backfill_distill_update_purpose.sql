-- Backfill: historically, all distill LLM calls were logged with
-- purpose='distill' regardless of whether the call was for a new-agent
-- creation or an existing-agent update. Phase 2 of the cost-attribution
-- fix emits purpose='distill_update' for updates going forward; this
-- migration relabels historical rows so the /insights Updates bucket
-- reflects the real spend history.
--
-- Rule: for each agent_id, the earliest distill (by timestamp) is the
-- creation; every subsequent distill for that agent is an update.
--
-- Idempotent: re-running is safe. Already-relabeled rows have
-- purpose='distill_update' so they no longer match the WHERE predicate
-- inside the CTE.
--
-- Must run AFTER migration 113 (Phase 1's HRBP orphan backfill) so that
-- HRBP-created agents' distill rows have their agent_id set before this
-- migration's ROW_NUMBER() partition. Otherwise they'd stay orphan in
-- Platform Analytics.
--
-- Historical HRBP-created agents whose distill rows still have
-- agent_id=NULL after migration 113 (no reliable match via idempotency
-- key + temporal window) are NOT recoverable here — their costs stay in
-- Platform Analytics.

UPDATE llm_usage_log
SET purpose = 'distill_update'
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY timestamp ASC) AS rn
    FROM llm_usage_log
    WHERE purpose = 'distill'
      AND agent_id IS NOT NULL
  ) ranked
  WHERE rn > 1
);
