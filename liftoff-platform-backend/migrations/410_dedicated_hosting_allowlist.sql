-- A tenant must be allowlisted before it can be moved to dedicated hosting.
--
-- Dedicated hosting is a premium tier: its own GCP project, its own Cloud SQL
-- instance, its own KMS key. Provisioning one is already admin-only, but
-- "an admin clicked it" is not the same as "we agreed to sell this customer a
-- dedicated project". The upgrade route had no record of that agreement, so a
-- mistaken or misdirected call created real, billable, hard-to-unwind
-- infrastructure and flipped the tenant's hosting mode in the same transaction.
--
-- This is the deliberate step: somebody records WHO approved dedicated hosting
-- for WHICH tenant and WHY, before the upgrade route will act. Same shape and
-- same reasoning as signup_preapprovals — a manual gate that leaves an audit
-- trail, rather than a permission that lives only in whoever holds the token.
--
-- Not RLS-scoped: this is a platform-operator table about tenants, read only by
-- admin paths that already run under withAdminScope. It deliberately carries no
-- tenant FK cascade — revoking an approval must not be a side effect of tenant
-- churn, and the history of who approved what should outlive the row it
-- approved.

CREATE TABLE IF NOT EXISTS dedicated_hosting_allowlist (
  tenant_id     UUID PRIMARY KEY,
  approved_by   TEXT        NOT NULL,
  reason        TEXT        NOT NULL,
  approved_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set when an approval is withdrawn. Kept rather than deleted so "who
  -- approved this, and did anyone revoke it" stays answerable.
  revoked_at    TIMESTAMPTZ,
  revoked_by    TEXT
);

COMMENT ON TABLE dedicated_hosting_allowlist IS
  'Tenants approved for dedicated GCP hosting. The upgrade-to-dedicated admin route refuses any tenant without a live (non-revoked) row here.';

-- The upgrade route asks exactly one question: is there a live approval for
-- this tenant. Partial index so that lookup stays a single index probe.
CREATE INDEX IF NOT EXISTS dedicated_hosting_allowlist_live
  ON dedicated_hosting_allowlist (tenant_id)
  WHERE revoked_at IS NULL;
