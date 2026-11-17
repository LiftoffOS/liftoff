-- Migration 001: workforce_plans table
--
-- Core lifecycle table for CAIO-assisted agent workforce plans.
-- Adapted from platform-backend migration 085.

CREATE TABLE workforce_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  account_id UUID NOT NULL,
  title VARCHAR(500),
  status VARCHAR(30) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_approval', 'approved', 'provisioning', 'completed', 'failed')),
  agents JSONB NOT NULL DEFAULT '[]'::jsonb,
  org_chart JSONB,
  thread_id UUID,
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  rejected_reason TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_workforce_plans_tenant_status
  ON workforce_plans(tenant_id, status, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_workforce_plans_thread
  ON workforce_plans(thread_id)
  WHERE deleted_at IS NULL AND thread_id IS NOT NULL;
