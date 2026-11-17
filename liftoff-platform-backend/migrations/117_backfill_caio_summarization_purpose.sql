-- Phase 4 backfill: historical rolling-summary LLM calls for CAIO
-- conversations were logged with purpose='insights_summarization' because
-- generateRollingSummary hardcoded that purpose regardless of the caller.
-- Phase 4 adds a purpose override so new CAIO summaries log as
-- 'caio_workforce_planning_summarization'; this migration relabels
-- historical rows we can confidently attribute to CAIO.
--
-- Heuristic: for each historical insights_summarization row, check
-- whether a CAIO thread (team_plan_threads + team_plan_messages) had a
-- message written within the 5 minutes preceding the summary timestamp,
-- AND whether no insights chat thread had activity in the same window.
-- If both conditions hold, the summary almost certainly came from CAIO.
--
-- Confidence: moderate. If both thread types had activity in the window
-- (rare for most tenants today), we leave the row alone — it stays under
-- Platform Analytics, so we under-attribute to Workforce Planning rather
-- than over-attribute.
--
-- Idempotent: already-relabeled rows no longer match
-- purpose = 'insights_summarization' so re-running is a no-op.

-- team_plan_threads.tenant_id and insights_chat_threads.tenant_id are both
-- UUID; llm_usage_log.tenant_id is TEXT (per migration 066). Cast the UUID
-- sides to text so the = operator resolves across the EXISTS subqueries.
UPDATE llm_usage_log lul
SET purpose = 'caio_workforce_planning_summarization'
WHERE lul.purpose = 'insights_summarization'
  AND EXISTS (
    SELECT 1
    FROM team_plan_threads tpt
    JOIN team_plan_messages tpm ON tpm.thread_id = tpt.id
    WHERE tpt.tenant_id::text = lul.tenant_id
      AND tpm.created_at BETWEEN (lul.timestamp - INTERVAL '5 minutes') AND lul.timestamp
  )
  AND NOT EXISTS (
    SELECT 1
    FROM insights_chat_threads ict
    JOIN insights_chat_messages icm ON icm.thread_id = ict.id
    WHERE ict.tenant_id::text = lul.tenant_id
      AND icm.created_at BETWEEN (lul.timestamp - INTERVAL '5 minutes') AND lul.timestamp
  );
