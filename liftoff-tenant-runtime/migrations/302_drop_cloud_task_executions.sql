-- §4.7-PR2: retire cloud_task_executions.
--
-- Cloud Tasks run-level idempotency is now executeTask's own concern (it claims an
-- event_processing_ledger 'agent_run' row keyed on triggerKey = the stable
-- X-CloudTasks-TaskName). event_processing_ledger's built-in 5-minute stale-reclaim
-- also fixes the old "stuck-running -> skip -> task abandoned" bug for free — no
-- heartbeat/lease needed. runWithTaskIdempotency + this table are removed.
--
-- Renumber on merge if 302 is taken upstream.

DROP TABLE IF EXISTS cloud_task_executions;
