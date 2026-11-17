-- 435: close human-triggered runs that have been stuck for more than 7 days,
-- quietly.
--
-- The stalled-run reconciler's human sweep (closeStalledHumanRuns,
-- src/scheduling/stalled-run-reconciler.ts) closes a chat run that stopped
-- heartbeating. It now looks back only 7 days (HUMAN_WINDOW). Anything older is
-- closed here, once.
--
-- Why not let the sweep do it: its first pass over a long-stuck backlog would
-- close runs started weeks or months earlier. The sweep's close is a live
-- failure: it posts
-- the agent_execution error audit row (a new Activity entry and a control-plane
-- run.failed webhook, dated today) and hands the run's spend to billing. For
-- runs months old, that replays history as fresh failures and bills it now.
-- So these are closed, but with none of that.
--
-- What this writes, for the same runs the sweep would close (human-triggered,
-- still open, no pending resume or approval, run state silent 'running' for 30
-- minutes or absent), started more than 7 days ago:
--   - invocations: outcome 'error', failure_class 'stalled', completed_at NOW(),
--     an error_message saying it was closed in bulk as a stale run;
--   - agent_run_states: 'running' -> 'failed';
--   - agent_invocation_signals: pending aborts consumed (a Stop that never
--     reached the run is answered by this close);
--   - chat_turn_locks: deleted, so the thread takes the next message;
--   - agents.runtime_status: 'RUNNING' -> 'IDLE' only when the agent has no
--     other open invocation. Any other status (WAITING_FOR_HUMAN, FAILED,
--     STOPPING) belongs to something else and is left alone.
--
-- Not billed. Three things could otherwise pick these rows up:
--   - the stalled-billing reconciler reads only reconciliation_status =
--     'pending' (stalled-run-billing-reconciler.ts). Set 'unrecoverable', the
--     existing terminal "will not be billed" state, which it never selects;
--   - billing-queued-reconciliation replays billing_queued = 'pending' rows
--     completed 5 minutes to 35 days ago (jobs/billing-queued-reconciliation.ts),
--     and an open run is 'pending' by default, so the completed_at written here
--     would put every one of them in its window. Set 'expired' (migration 369:
--     completed, never published, never will be), which it never selects;
--   - the control plane's runtime ingester reads completed invocations by
--     started_at past its cursor, which is already past these runs.
-- No audit row and no event are written, so there is no Activity entry and no
-- webhook.
--
-- The 7 days here and HUMAN_WINDOW in the reconciler must agree: the sweep
-- takes started_at > NOW() - 7 days, this takes the rest.
--
-- None of these tables is row-level-security protected, so there is no NO
-- FORCE / FORCE wrapper.
--
-- One statement: every step acts on exactly the runs this execution closed
-- (`closed`), and nothing is left half-done. The agent reset reads the
-- statement's snapshot, where those runs are still open, so it excludes them
-- by id rather than by completed_at.
--
-- Idempotent: only open runs are selected, so a second run closes nothing and
-- every later step has nothing to act on.

WITH closed AS (
  UPDATE invocations i SET
      outcome = 'error',
      failure_class = 'stalled',
      error_message = 'stalled: closed in bulk as a stale run older than 7 days (migration 435); not billed, no Activity entry',
      reconciliation_status = 'unrecoverable',
      billing_queued = 'expired',
      completed_at = NOW()
    WHERE i.triggered_by = 'human'
      AND i.outcome IS NULL AND i.completed_at IS NULL
      AND i.started_at <= NOW() - INTERVAL '7 days'
      AND NOT EXISTS (SELECT 1 FROM agent_scheduled_invocations asi
                      WHERE asi.scheduled_by_invocation_id = i.id::text AND asi.status = 'pending')
      AND NOT EXISTS (SELECT 1 FROM hitl_approval_requests h
                      WHERE h.tenant_id = i.tenant_id AND h.invocation_id = i.id AND h.status = 'pending')
      AND (
        EXISTS (SELECT 1 FROM agent_run_states ars
                WHERE ars.invocation_id = i.id::text
                  AND ars.state->>'status' = 'running'
                  AND ars.updated_at < NOW() - INTERVAL '30 minutes')
        OR NOT EXISTS (SELECT 1 FROM agent_run_states ars WHERE ars.invocation_id = i.id::text)
      )
    RETURNING i.id, i.tenant_id, i.agent_id
),
run_states AS (
  UPDATE agent_run_states
     SET state = jsonb_set(state, '{status}', '"failed"'), updated_at = NOW()
   WHERE invocation_id IN (SELECT id::text FROM closed)
     AND state->>'status' = 'running'
  RETURNING 1
),
aborts AS (
  UPDATE agent_invocation_signals
     SET consumed_at = NOW()
   WHERE invocation_id IN (SELECT id FROM closed)
     AND signal_kind = 'abort' AND consumed_at IS NULL
  RETURNING 1
),
locks AS (
  DELETE FROM chat_turn_locks l
   USING closed c
   WHERE l.tenant_id = c.tenant_id AND l.acquired_by_invocation_id = c.id
  RETURNING 1
),
idled AS (
  UPDATE agents a
     SET runtime_status = 'IDLE', updated_at = NOW()
   WHERE a.runtime_status = 'RUNNING'
     AND EXISTS (SELECT 1 FROM closed c WHERE c.agent_id = a.id AND c.tenant_id = a.tenant_id)
     AND NOT EXISTS (SELECT 1 FROM invocations o
                     WHERE o.tenant_id = a.tenant_id AND o.agent_id = a.id
                       AND o.completed_at IS NULL
                       AND o.id NOT IN (SELECT id FROM closed))
  RETURNING 1
)
SELECT (SELECT count(*) FROM closed)     AS closed,
       (SELECT count(*) FROM run_states) AS run_states_failed,
       (SELECT count(*) FROM aborts)     AS aborts_consumed,
       (SELECT count(*) FROM locks)      AS locks_released,
       (SELECT count(*) FROM idled)      AS agents_idled;
