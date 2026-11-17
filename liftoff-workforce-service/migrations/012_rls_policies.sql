-- Migration 012: Row-Level Security policies
--
-- Every table that contains tenant-scoped data is protected by a policy that
-- checks app.current_tenant_id (a session-local GUC). The application sets
-- this via SET LOCAL before any query using withTenantContext() in rls.ts.
--
-- The workforce_app DB role runs with BYPASSRLS=false, so these policies apply
-- to all application queries. Background workers that need cross-tenant access
-- (outbox worker, stuck-plan resumer) use a service role with BYPASSRLS=true
-- or connect to the DB directly without going through withTenantContext().
--
-- Tables NOT protected by RLS (internal/service-only):
--   capability_tokens, hrbp_provisioning_*, processed_events,
--   outbox_events, workforce_audit_log, plan_pending_integrations

-- workforce_plans
ALTER TABLE workforce_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY workforce_plans_tenant_isolation ON workforce_plans
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
  );

-- team_plan_threads
ALTER TABLE team_plan_threads ENABLE ROW LEVEL SECURITY;

CREATE POLICY team_plan_threads_tenant_isolation ON team_plan_threads
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
  );

-- team_plan_messages (isolated via thread ownership)
ALTER TABLE team_plan_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY team_plan_messages_tenant_isolation ON team_plan_messages
  USING (
    thread_id IN (
      SELECT id FROM team_plan_threads
      WHERE tenant_id = current_setting('app.current_tenant_id', true)::uuid
    )
  );

-- team_plan_rate_limit_events (has direct tenant_id column)
ALTER TABLE team_plan_rate_limit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY team_plan_rate_limit_events_tenant_isolation ON team_plan_rate_limit_events
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
  );

-- caio_memory
ALTER TABLE caio_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY caio_memory_tenant_isolation ON caio_memory
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
  );
