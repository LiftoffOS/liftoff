-- Workforce Plans
--
-- A workforce plan is a draft document the Chief AI Officer (CAI) co-authors
-- with a human leader. It describes a set of agents to provision in a single
-- batch, including agent specs, an optional org chart, and a budget estimate.
--
-- Lifecycle:
--
--   draft -> pending_approval -> approved -> provisioning -> completed
--     ^           |                  ^                          |
--     +-----------+ (reject)         +--------------------------+ (reopen for amendment)
--                                    draft (also direct approve from draft)
--
-- Notes:
--   - `agents` is a JSONB array of agent spec objects (see WorkforcePlanAgentSpec
--     in src/workforce-plans/types.ts). Bounded to ~50 agents per plan in practice.
--   - `revision` increments on each reopen so we can audit amendment history without
--     a separate amendments table.
--   - `thread_id` links to the CAI chat thread that produced the plan. The FK target
--     table (team_plan_threads) does not exist yet (Phase 3) so the column is a
--     bare UUID for now; an FK constraint will be added in migration 086.
--   - Soft delete via `deleted_at`. The partial index on (tenant_id, status) skips
--     deleted rows so list queries stay cheap.

CREATE TABLE workforce_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  account_id UUID NOT NULL,
  title VARCHAR(500),
  status VARCHAR(30) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_approval', 'approved', 'provisioning', 'completed', 'failed')),
  agents JSONB NOT NULL DEFAULT '[]'::jsonb,
  org_chart JSONB,
  budget_estimate JSONB,
  thread_id UUID,
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  rejected_reason TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tenant-scoped listing by status (the dashboard's primary read path).
CREATE INDEX idx_workforce_plans_tenant_status
  ON workforce_plans(tenant_id, status, updated_at DESC)
  WHERE deleted_at IS NULL;

-- Lookup by linked thread (for the chat service to load plan state into the
-- conversation context on each turn).
CREATE INDEX idx_workforce_plans_thread
  ON workforce_plans(thread_id)
  WHERE deleted_at IS NULL AND thread_id IS NOT NULL;
