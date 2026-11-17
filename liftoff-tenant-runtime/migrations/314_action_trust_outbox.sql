-- Durable outbox for delivering approval-resolution trust decisions to the governance engine.
--
-- A row is enqueued in the SAME transaction as the approval-status UPDATE, so a resolved
-- approval is never recorded without its trust decision being scheduled for delivery. A
-- background drainer claims due rows and POSTs them to
-- /api/governance/action-trust/decisions. The governance side is idempotent on its
-- source_key, so redelivery is safe.
--
-- Tenant-scoped with FORCE row-level security on app.tenant_id (the tenant-runtime GUC),
-- like every other tenant table in this DB. tenant-runtime is single-tenant per deployment,
-- so the enqueue (inside the approval's withTenantScope) and the drain (inside
-- withTenantScope(getLocalTenantId())) both run with the GUC set — RLS is satisfied while
-- still enforcing tenant isolation as defense-in-depth.

CREATE TABLE action_trust_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  approval_id UUID NOT NULL,
  payload JSONB NOT NULL,            -- the PostDecisionsBody sent to governance
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','completed','failed')),
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 10,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ato_claim ON action_trust_outbox (next_attempt_at)
  WHERE status = 'pending';

ALTER TABLE action_trust_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_trust_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY action_trust_outbox_tenant_isolation ON action_trust_outbox
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
