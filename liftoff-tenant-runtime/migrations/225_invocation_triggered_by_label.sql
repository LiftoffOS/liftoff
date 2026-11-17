-- 221: invocation triggered_by_label column for granular trigger attribution.
--
-- Per plan audit finding #1: the existing invocations.triggered_by CHECK
-- constraint (migration 015) accepts only {'human','agent','cron','event'}.
-- Granular labels (companion:<label>, reactive:<label>, workflow_delay:<id>,
-- computed_metric:<label>) ride in this NEW optional column so all existing
-- analytics queries keep working unchanged.
--
-- Precursor migration that lets the new trigger sources record granular attribution
-- multi-companion crons/B/C trigger source emits a label.

ALTER TABLE invocations ADD COLUMN IF NOT EXISTS triggered_by_label TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_invocations_triggered_by_label
  ON invocations (triggered_by_label) WHERE triggered_by_label IS NOT NULL;

COMMENT ON COLUMN invocations.triggered_by_label IS
  'Granular trigger source within the broad triggered_by category. Example values: companion:weekly-summary, reactive:campaign-bounce-watch, computed_metric:mrr-drop, workflow_delay:<workflowId>. Used for cost-attribution and observability dashboards.';
