-- Phase 5 (SE-004): Rate-limit ledger for the distill endpoint.
-- Follows the same schema as insights_rate_limit_events and
-- team_plan_rate_limit_events, used by chat-rate-limiter.ts.

CREATE TABLE IF NOT EXISTS distill_rate_limit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  account_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_distill_rate_limit_tenant
  ON distill_rate_limit_events (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_distill_rate_limit_account
  ON distill_rate_limit_events (account_id, created_at DESC);
