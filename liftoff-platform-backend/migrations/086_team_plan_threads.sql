-- Team Plan Chat Threads
--
-- The Chief AI Officer (CAI) talks to human leaders on /teams/plan via a
-- chat interface. This migration adds the persistence tables that back
-- that conversation:
--
--   team_plan_threads  - one row per planning conversation. Links (optionally)
--                        to a workforce_plan via `workforce_plan_id` so the
--                        chat service can inject the current plan state into
--                        the context on each turn.
--   team_plan_messages - one row per turn (user or assistant). `visualization_blocks`
--                        holds any inline blocks the CAI emitted (metric cards,
--                        tables, org charts, etc.) parsed out of the streamed
--                        response and stored alongside the text.
--   team_plan_rate_limit_events - per-turn rate-limit ledger. Parallel to
--                        `insights_rate_limit_events` so a user burning through
--                        insights doesn't throttle their planning work (and
--                        vice versa).
--
-- The schema mirrors migrations 074 + 078 (insights chat + rolling summary)
-- so the chat-repository can be cloned wholesale. The one addition is the
-- `workforce_plan_id` column on the thread, which lets the chat service find
-- the current draft without a reverse lookup through the workforce_plans
-- table (migration 085 already reserved a `thread_id` column pointing back,
-- but the primary read path is thread -> plan).
--
-- Rolling summary support (clone of migration 078) is included inline in
-- this migration rather than split across two files: we have no insights
-- chat "before summarization" period to preserve for team-plan threads.

CREATE TABLE team_plan_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  account_id UUID NOT NULL,
  title VARCHAR(500),
  workforce_plan_id UUID,
  rolling_summary JSONB,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Admin/owner listing (all tenant threads)
CREATE INDEX idx_team_plan_threads_tenant ON team_plan_threads(tenant_id, updated_at DESC)
  WHERE deleted_at IS NULL;
-- Member/viewer listing (own threads only)
CREATE INDEX idx_team_plan_threads_account ON team_plan_threads(tenant_id, account_id, updated_at DESC)
  WHERE deleted_at IS NULL;
-- Reverse lookup for the workforce plans router (future HRBP UI) to find
-- the chat thread that produced a given plan. Partial so the index stays
-- small when most threads have no plan linked yet.
CREATE INDEX idx_team_plan_threads_workforce_plan
  ON team_plan_threads(workforce_plan_id)
  WHERE deleted_at IS NULL AND workforce_plan_id IS NOT NULL;

CREATE TABLE team_plan_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES team_plan_threads(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  visualization_blocks JSONB,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_team_plan_messages_thread ON team_plan_messages(thread_id, created_at ASC);

-- Rate limiting events for team plan chat. Separate from insights events so
-- the two workloads don't throttle each other.
CREATE TABLE team_plan_rate_limit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  account_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_team_plan_rate_limit_tenant ON team_plan_rate_limit_events(tenant_id, created_at DESC);
CREATE INDEX idx_team_plan_rate_limit_account ON team_plan_rate_limit_events(account_id, created_at DESC);
