-- Migration 016: let a person stop the Chief AI Officer mid-turn.
--
-- Agent chat got a user stop in ADR-041; /teams/plan did not, and the CAIO is
-- the surface where it matters most because its turn is a tool-use loop that can
-- run for a minute or more.
--
-- The signal has to be durable for the same reason presence is. The CAIO turn is
-- an async generator inside one workforce-service request, and Cloud Run has no
-- session affinity, so the stop request almost never lands on the instance
-- holding the turn. There is nothing in-process for it to reach. So the stop is
-- written down and the running loop reads it between iterations — the same shape
-- tenant-runtime uses for agent chat (agent_invocation_signals).
--
-- Keyed by thread_id, not turn_id: one live turn per thread is what the composer
-- already enforces, and it means a stop only has to name the thread the person
-- is looking at. turn_id rides along so a turn can tell whether the claim is
-- still its own.

BEGIN;

CREATE TABLE team_plan_active_turns (
  thread_id         UUID PRIMARY KEY,
  tenant_id         UUID NOT NULL,
  turn_id           UUID NOT NULL,
  -- Who started the turn. The stop is open to anyone who can see the thread, so
  -- this is for the audit trail rather than for permission.
  account_id        UUID NOT NULL,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stop_requested_at TIMESTAMPTZ,
  stop_requested_by UUID,
  FOREIGN KEY (thread_id, tenant_id)
    REFERENCES team_plan_threads (id, tenant_id) ON DELETE CASCADE
) WITH (fillfactor = 70);

-- No index beyond the primary key on purpose: every read and write here names
-- the thread, and the table holds one row per thread with a turn in flight —
-- single digits at any moment, not a log.

ALTER TABLE team_plan_active_turns ENABLE ROW LEVEL SECURITY;
CREATE POLICY team_plan_active_turns_tenant_isolation ON team_plan_active_turns
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON team_plan_active_turns TO workforce_app;

COMMIT;
