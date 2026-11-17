-- Migration 495: the thread a platform assistant's conversation uses with each
-- colleague it brings in.
--
-- Liftoff records this in liftoff_thread_delegations (349), keyed on its own
-- threads table. The Insights Manager and the Chief AI Officer can now hand a
-- turn to a colleague the same way, and they need the same record for the
-- same reason: the colleague's plan, drafts and own history live in the
-- paired thread, so the second hand-over in a conversation about the same
-- piece of work must land in the thread the first one opened, not in a fresh
-- one. A preview the Chief AI Officer made on the first hand-over is applied
-- on the second, and the handle it minted lives in that thread.
--
-- One table for both surfaces rather than one per surface, because the two
-- rows are identical apart from which table `thread_id` points at, and one of
-- those tables (team_plan_threads) is in the workforce service's database.
-- So `thread_id` carries no foreign key, exactly like `delegate_thread_id`
-- here and in 349; `surface` says which table it names.
--
-- `target_kind` names the colleague: a platform assistant, or an AI team's
-- internal_agents.id in `target_id` the day one of these surfaces can hand
-- to a team. Neither can today, so `target_id` is nullable and unused, but
-- the column is here so that change is one writer and not a schema change.
--
-- RLS as 490: every read and write carries the tenant.

CREATE TABLE IF NOT EXISTS assistant_thread_delegations (
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  surface            TEXT NOT NULL CHECK (surface IN ('insights', 'caio')),
  thread_id          UUID NOT NULL,
  target_kind        TEXT NOT NULL CHECK (target_kind IN ('liftoff', 'caio', 'insights', 'team')),
  target_id          UUID,
  delegate_thread_id UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One paired thread per (conversation, colleague). Partial pair so a
-- singleton colleague (NULL target_id) and a team (its id) are each unique.
CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_thread_delegations_singleton
  ON assistant_thread_delegations (tenant_id, surface, thread_id, target_kind)
  WHERE target_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_thread_delegations_team
  ON assistant_thread_delegations (tenant_id, surface, thread_id, target_kind, target_id)
  WHERE target_id IS NOT NULL;

ALTER TABLE assistant_thread_delegations ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_thread_delegations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON assistant_thread_delegations
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE assistant_thread_delegations IS
  'The colleague''s own thread paired with one Insights Manager or Chief AI Officer conversation, per colleague, so a hand-over continues the thread the first hand-over opened. thread_id names insights_chat_threads.id or, in the workforce database, team_plan_threads.id, by surface.';
