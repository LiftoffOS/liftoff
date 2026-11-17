-- Migration 004: instructions_md column on workforce_plans
--
-- Stores an optional CLAUDE.md-style instructions document that applies to
-- every agent provisioned from this plan. Set via
-- PATCH /workforce-plans/:planId/instructions-md (owner/admin only).

ALTER TABLE workforce_plans
  ADD COLUMN IF NOT EXISTS instructions_md TEXT;
