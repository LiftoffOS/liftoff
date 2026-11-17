-- Migration 002: team_plan_threads and team_plan_messages
--
-- Chat thread storage for the CAIO workforce planning assistant.
-- Adapted from platform-backend migration 086.

CREATE TABLE team_plan_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  account_id UUID NOT NULL,
  title VARCHAR(500),
  title_source VARCHAR(20),
  title_generated_at TIMESTAMPTZ,
  workforce_plan_id UUID REFERENCES workforce_plans(id) ON DELETE SET NULL,
  rolling_summary JSONB,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_team_plan_threads_tenant
  ON team_plan_threads(tenant_id, updated_at DESC);

CREATE INDEX idx_team_plan_threads_account
  ON team_plan_threads(tenant_id, account_id, updated_at DESC);

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

CREATE INDEX idx_team_plan_messages_thread
  ON team_plan_messages(thread_id, created_at ASC);

CREATE TABLE team_plan_rate_limit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  account_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tplre_tenant_account_time
  ON team_plan_rate_limit_events(tenant_id, account_id, created_at DESC);

-- Back-fill the FK from workforce_plans.thread_id now that team_plan_threads exists.
ALTER TABLE workforce_plans
  ADD CONSTRAINT fk_workforce_plans_thread
  FOREIGN KEY (thread_id) REFERENCES team_plan_threads(id) ON DELETE SET NULL;
