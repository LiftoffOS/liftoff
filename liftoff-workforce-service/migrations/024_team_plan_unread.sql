-- 024: unread state for team-plan threads
--
-- Platform-backend's agent-chat unread design (its migration 338, ADR-046;
-- Liftoff and Insights copies are 433/434), applied to the one chat surface
-- whose threads live in THIS database: a reply clock denormalised onto the
-- thread, and a durable per-(thread, account) read marker. The frontend draws
-- the dot for it on the teams page's Plan Workforce button and in the chat
-- history modal, served through the /api/team-plan proxy.
--
-- The account and tenant ids are bare UUIDs, like every other table here:
-- accounts and tenants live in platform-backend's database, so there is
-- nothing to foreign-key them to (the same trade migration 014 documents for
-- presence).

-- The reply clock. Deliberately NOT updated_at: that moves when the *person*
-- sends a message too, which would make every thread the person just wrote in
-- unread. NULL means the Chief AI Officer has never replied in this thread,
-- which is never unread. ADD COLUMN is a schema change rather than a row
-- write, so it needs none of the FORCE / NO FORCE handling a data migration
-- on a policied table would (same note as 020/022/023) - and team_plan_threads
-- must stay un-FORCEd regardless, per migration 017's warning.
ALTER TABLE team_plan_threads
  ADD COLUMN IF NOT EXISTS last_assistant_message_at TIMESTAMPTZ;

-- The read marker, per account: two people in one workspace have genuinely
-- different unread state, and reading a plan thread is workspace-wide.
--
-- The composite FK rides team_plan_threads_id_tenant_key (migration 014), the
-- same guarantee presence uses: a marker cannot be pointed at another
-- tenant's thread even if tenant_id were wrong. fillfactor for the same
-- reason presence and active_turns use it - these rows are updated far more
-- often than inserted, and leaving room in the page keeps the last_read_at
-- rewrite a HOT update.
CREATE TABLE team_plan_thread_reads (
  thread_id    UUID NOT NULL,
  account_id   UUID NOT NULL,
  tenant_id    UUID NOT NULL,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, account_id),
  FOREIGN KEY (thread_id, tenant_id)
    REFERENCES team_plan_threads (id, tenant_id) ON DELETE CASCADE
) WITH (fillfactor = 70);

-- RLS, in the 014 style: ENABLE + policy, and WITH CHECK because this table
-- takes request-path writes (INV-WF-001).
ALTER TABLE team_plan_thread_reads ENABLE ROW LEVEL SECURITY;
CREATE POLICY team_plan_thread_reads_tenant_isolation ON team_plan_thread_reads
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Default privileges already cover new tables (setup_grants.sql), but the
-- explicit grant matches 014/016's belt-and-braces style.
GRANT SELECT, INSERT, UPDATE, DELETE ON team_plan_thread_reads TO workforce_app;

-- The count query filters on the clock; the existing tenant index is on
-- (tenant_id, updated_at) and does not serve it. The marker side needs
-- nothing new: the primary key on (thread_id, account_id) covers the join.
CREATE INDEX idx_team_plan_threads_tenant_unread
  ON team_plan_threads (tenant_id, last_assistant_message_at DESC)
  WHERE deleted_at IS NULL AND last_assistant_message_at IS NOT NULL;

-- No backfill, deliberately (same argument as platform-backend's 338, which
-- tried one and reverted it): the clock stays NULL on every existing thread,
-- so nothing that predates this carries a dot, and the first indicator anyone
-- sees is a reply that genuinely arrived after it shipped.
