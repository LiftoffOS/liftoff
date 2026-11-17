-- Migration 017: Add admission-required columns to cached_entitlements.
--
-- Migration 001 created cached_entitlements with only:
--   operational_status, entitlements_json, entity_version, cached_at, expires_at, updated_at
--
-- The admission service (src/admission/service.ts) queries two additional
-- columns that were never added:
--
--   getEntitlement() (hot path — called on every Preflight):
--     SELECT operational_status, agent_execution_allowed FROM cached_entitlements
--     Missing agent_execution_allowed → "column does not exist" → HTTP 500 on every Preflight
--
--   getTenantQuotas() (called only when requiredCredits > 0):
--     SELECT e.included_monthly_credits, e.overage_ceiling, e.overage_allowed FROM cached_entitlements
--     All three missing → SQL error whenever a credit-bearing action is checked
--
-- The platform-backend EntitlementEventPayload already carries all four
-- fields (agentExecutionAllowed, includedMonthlyCredits, overageCeiling,
-- overageAllowed). The entitlements subscriber (src/events/entitlements-subscriber.ts)
-- stores the full payload in entitlements_json but doesn't populate these
-- columns directly — that subscriber is updated in this same commit.
--
-- Defaults are conservative: agent execution allowed, no overage.

ALTER TABLE cached_entitlements
  ADD COLUMN IF NOT EXISTS agent_execution_allowed  BOOLEAN        NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS included_monthly_credits NUMERIC(18, 6),          -- NULL = unlimited
  ADD COLUMN IF NOT EXISTS overage_ceiling          NUMERIC(18, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS overage_allowed          BOOLEAN        NOT NULL DEFAULT false;
