-- Migration 200: Complete RLS coverage on tenant-scoped tables added since 095
--
-- Migration 095 enabled RLS on every table with a tenant_id column that existed
-- at that time, using a DO-loop over information_schema. Tables created in
-- later migrations (097–199) added tenant_id columns but RLS was never enabled
-- on them — 095's DO-loop only ran once.
--
-- Tables with tenant_id where RLS is OFF fall into three groups:
--   - non-partition base tables (e.g., agent_messages, knowledge_items,
--     billing_spend_events, workflow_*, mcp_tokens, setup_tokens, ...)
--   - partitions: cost_attribution_events_* + tenant_resource_usage_*
--   - the partitioned parent: cost_attribution_events (relkind='p')
--
-- This migration re-runs the 095 DO-loop to catch all new tables. Partition
-- handling and an auto-enable event trigger were considered but deferred to
-- the follow-up PR (see steps 2 and 3 below).
--
-- Tables intentionally EXCLUDED:
--   - distillation_cache: LLM-prompt cache, legitimately shared across tenants
--     (per plan §0.3, line 1211).
--
-- All callers wrapped in this PR — RLS enforced on every other tenant-scoped
-- table (full plan §0.3 closure):
--   - mcp_tokens, setup_tokens: src/mcp-server/mcp-auth.ts and
--     src/claude-code-proxy/service.ts use withAdminScope (pre-tenant-context
--     auth lookups) + withTenantScope where tenantId is known.
--   - generated_files: src/generated-files/router.ts wrapped per request.
--   - slack_user_mappings, agent_slack_apps, agent_slack_installs: all
--     callers in src/agent-chat/slack-adapter/* wrapped (withTenantScope
--     for tenant-known paths, withAdminScope for webhook/oauth pre-tenant).
--   - knowledge_items, knowledge_webhook_subscriptions: src/knowledge/
--     repository.ts wrapped (withTenantScope per request, withAdminScope
--     for webhook-by-token lookups).
--   - external_agent_integrations: src/integrations/repository.ts wrapped.
--   - a2a_task_registry: src/a2a/rpc-router.ts wrapped.
--   - agent_skill_metrics: src/scripts/backfill-skill-metrics.ts uses
--     withAdminScope for cross-tenant scan + withTenantScope per agent.
--   - agent_messages: src/mcp-server/service.ts and
--     src/internal-api/platform-tools-router.ts wrapped; the maintenance
--     expiry job in src/maintenance/expire-agent-messages.ts runs under
--     withAdminScope (intentional cross-tenant sweep).
--   - skill_feedback_log: src/internal-agents/skill-feedback-service.ts
--     wrapped in withTenantScope.
--   - alerts: src/operator-dashboard/service.ts:getTenantAlerts wrapped in
--     withAdminScope (operator dashboard inherently cross-tenant).
--   - billing_spend_events: src/billing/billing-controls-internal-router.ts
--     wrapped in withAdminScope (cross-tenant backfill within an account).
--   - cost_attribution_events / cost_attribution_snapshots: ingesters
--     (anthropic-billing-reconciler, openai-billing-reconciler,
--     backfill-correlator, repository.insertEvents, snapshot-service)
--     wrapped in withAdminScope (cross-tenant batch jobs); per-tenant reads
--     (repository.getCostBreakdown, getCostByAgent, attribution-service)
--     wrapped in withTenantScope.
--   - tenant_resource_usage + partitions: no in-tree callers; RLS enabled
--     for defense-in-depth (operator-dashboard rollups go through other
--     tables, not direct queries).
--   - workflow_definitions, workflow_runs, workflow_tasks,
--     workflow_step_executions, workflow_step_events: src/workflow-engine/*
--     refactored — definition-service and run-service use withTenantScope
--     (request-scoped); step-executor, state-recovery, and the internal
--     HMAC callback in router.ts use withAdminScope (background workers,
--     no incoming tenant context).
--
-- One deprecated table is DROPPED:
--   - internal_agents_modelconfig_pre_197: pre-migration-197 backup, no longer needed.

-- ============================================================================
-- Step 0: Drop deprecated backup table
-- ============================================================================

DROP TABLE IF EXISTS internal_agents_modelconfig_pre_197;

-- ============================================================================
-- Step 1: Re-run 095's DO-loop over every tenant-scoped table.
-- Idempotent: ENABLE is no-op when already enabled, DROP POLICY IF EXISTS
-- handles re-runs, CREATE POLICY uses the same naming convention as 095.
-- ============================================================================

DO $$
DECLARE
  rec RECORD;
  policy_name TEXT;
  cast_expr TEXT;
  excluded_tables TEXT[] := ARRAY[
    -- Same exclusions as 095: platform-global tables
    'accounts', 'plans', 'subscriptions', 'staff_roles', 'tenants',
    'invite_requests', 'feature_flags', 'passkeys',
    'schema_migrations', 'migration_jobs', 'migration_history',
    -- New exclusions in 200:
    'distillation_cache'                       -- globally-shared LLM cache (intentional per plan)
    -- All other tenant-scoped tables (workflow_*, alerts, billing_spend_events,
    -- cost_attribution_events, cost_attribution_snapshots, tenant_resource_usage,
    -- plus the high-blast-radius set knowledge_items / knowledge_webhook_subscriptions /
    -- external_agent_integrations / a2a_task_registry / agent_skill_metrics /
    -- agent_messages / etc.) are now wrapped at every callsite in either
    -- withTenantScope (request-scoped paths) or withAdminScope (background
    -- workers, batch ingesters, cross-tenant operator paths). RLS is enabled
    -- on all of them by the DO-loop below.
  ];
  -- Partition handling: partition children appear as 'BASE TABLE' in
  -- information_schema.tables (e.g., cost_attribution_events_y2026m04) with
  -- their own tenant_id column. With the parent now in-scope for RLS, the
  -- DO-loop also enables RLS on each partition individually, which is the
  -- right behavior — PG routes inserts on the parent to the partition and
  -- the partition's USING/WITH CHECK policy fires under tenant scope.
  excluded_partition_parents TEXT[] := ARRAY[]::text[];
BEGIN
  FOR rec IN
    SELECT c.table_name, c.data_type, c.udt_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.column_name = 'tenant_id'
      AND c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND c.table_name != ALL(excluded_tables)
      -- Skip partition children whose parents are deferred.
      AND NOT EXISTS (
        SELECT 1
        FROM pg_inherits inh
        JOIN pg_class child  ON child.oid = inh.inhrelid
        JOIN pg_class parent ON parent.oid = inh.inhparent
        JOIN pg_namespace nch ON nch.oid = child.relnamespace
        WHERE nch.nspname = 'public'
          AND child.relname = c.table_name
          AND parent.relname = ANY(excluded_partition_parents)
      )
    ORDER BY c.table_name
  LOOP
    policy_name := 'tenant_isolation_' || rec.table_name;

    -- Match cast to the column's actual type.
    -- Most tables use UUID, some legacy use TEXT/VARCHAR.
    IF rec.udt_name = 'uuid' THEN
      cast_expr := 'current_setting(''app.current_tenant_id'')::uuid';
    ELSE
      cast_expr := 'current_setting(''app.current_tenant_id'')::text';
    END IF;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', rec.table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_name, rec.table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = %s) WITH CHECK (tenant_id = %s)',
      policy_name, rec.table_name, cast_expr, cast_expr
    );

    RAISE NOTICE 'RLS enabled on % (tenant_id type: %)', rec.table_name, rec.udt_name;
  END LOOP;
END $$;

-- ============================================================================
-- Step 2: NO partition RLS in this migration.
--
-- The previous draft of this migration had a DO-loop that enabled RLS on every
-- partition of cost_attribution_events and tenant_resource_usage. That's
-- inconsistent with the exclusion list above — both parents are EXCLUDED
-- because their batch ingesters
-- (anthropic-billing-reconciler, openai-billing-reconciler, backfill-correlator,
-- and operator-dashboard) use getPool() without scope and would silently
-- return zero rows under RLS. Enabling RLS on the partitions alone would
-- break those ingesters because PG's partition pruning applies partition-level
-- RLS to queries against the parent.
--
-- Both parents AND their partitions are deferred to a follow-up PR that
-- refactors the ingesters to use withAdminScope.
-- ============================================================================

-- ============================================================================
-- Step 3: NO event trigger in this migration.
--
-- The previous draft installed an event trigger that auto-enabled RLS on new
-- partitions of cost_attribution_events / tenant_resource_usage. With those
-- parents deferred, the trigger would create the same ingester breakage on
-- every monthly partition Postgres auto-creates. Trigger will be added in
-- the follow-up PR that enables RLS on the parents.
-- ============================================================================
