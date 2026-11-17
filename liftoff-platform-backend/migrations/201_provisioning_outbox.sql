-- Migration 201: provisioning_outbox for at-least-once provisionSubscription retries
--
-- Background: TenantService.activate() now calls billing.provisionSubscription
-- synchronously on the happy path. On Stripe failure (network blip, rate limit,
-- card-issue), the failure enqueues a row in this outbox and a background worker
-- (src/billing/provisioning-outbox-worker.ts) retries with exponential backoff.

CREATE TABLE provisioning_outbox (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  action          TEXT NOT NULL CHECK (action IN ('provision_subscription')),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 10,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error      TEXT,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

-- Worker polls due rows
CREATE INDEX provisioning_outbox_due
  ON provisioning_outbox (status, next_attempt_at)
  WHERE status = 'pending';

-- Operator lookups per tenant
CREATE INDEX provisioning_outbox_tenant
  ON provisioning_outbox (tenant_id);

-- Prevent duplicate active rows for the same (tenant, action). enqueue
-- uses `INSERT ... ON CONFLICT (tenant_id, action) WHERE status IN
-- ('pending', 'in_progress') DO NOTHING` against this partial index so
-- re-enqueueing while a prior attempt is still pending or in-progress
-- is a no-op rather than a duplicate that could double-provision.
-- Completed/failed rows are EXCLUDED from the index, leaving operators
-- free to re-enqueue after a manual reset.
CREATE UNIQUE INDEX provisioning_outbox_unique_active
  ON provisioning_outbox (tenant_id, action)
  WHERE status IN ('pending', 'in_progress');

-- Note: no RLS on this table. The outbox is operator/admin scope only,
-- accessed exclusively through withAdminScope. No tenant-facing reads.
