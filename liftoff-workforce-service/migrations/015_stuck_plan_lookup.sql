-- Migration 015: a sanctioned cross-tenant read for the stuck-plan resumer.
--
-- findStuckProvisioningPlans() swept workforce_plans on the raw pool with a
-- comment claiming it "bypasses RLS". It bypassed nothing: the policy from
-- migration 012 reads app.current_tenant_id, a pool connection never sets it,
-- and `tenant_id = NULL` is not true — so the sweep matched zero rows on every
-- run and the resumer could never resume a plan.
--
-- Wrapping it in withTenantContext is not available here: the resumer is a
-- background sweep across every tenant, so there is no one tenant to scope to.
-- That is what SECURITY DEFINER is for. The function runs as its owner, which is
-- workforce_migrate — the role that created workforce_plans — and migration 012
-- ENABLEs row security without FORCE, so the owner is exempt. The bypass is
-- therefore explicit, named, and auditable in one place, rather than an
-- accidental property of which pool a caller happened to reach for.
--
-- IF workforce_plans IS EVER SWITCHED TO FORCE ROW LEVEL SECURITY, this stops
-- working (FORCE applies to the owner too) and the resumer goes quiet again in
-- exactly the way it just did. Whoever does that owns fixing this with it.
--
-- Hardening is the standard SECURITY DEFINER set: a pinned search_path so the
-- definer context cannot be steered at a shadowed table, and EXECUTE revoked
-- from PUBLIC and granted only to the app role.

BEGIN;

CREATE OR REPLACE FUNCTION workforce_find_stuck_provisioning_plans(
  stale_seconds INTEGER,
  max_rows      INTEGER
)
RETURNS TABLE (plan_id UUID, tenant_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, tenant_id
  FROM workforce_plans
  WHERE status = 'provisioning'
    AND deleted_at IS NULL
    AND updated_at < NOW() - make_interval(secs => stale_seconds)
  ORDER BY updated_at ASC
  LIMIT max_rows
$$;

REVOKE ALL ON FUNCTION workforce_find_stuck_provisioning_plans(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workforce_find_stuck_provisioning_plans(INTEGER, INTEGER) TO workforce_app;

COMMIT;
