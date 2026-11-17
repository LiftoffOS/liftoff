-- Drop two governance-shaped surfaces that no code reads.
--
-- Both outlived the concept they belonged to, and both are worse than ordinary
-- dead weight because they read like controls that are enforced.
--
-- internal_agents.delegates
--   Added in migration 080 alongside `engine_config`, for an execution-engine
--   abstraction that no longer exists. `engine_config` was dropped in migration
--   265 once it read nowhere; this survived that cleanup by omission.
--
--   It accepts an `endpoint`, an `auth.credentialSecretName`, a `tools` subset
--   and HITL `categories`, and it VALIDATES on write (the referenced external
--   agent must exist), so an operator filling it in has every reason to believe
--   they granted an endpoint with a credential and restricted a tool surface.
--   They granted nothing: the tenant runtime mirrors the column and never reads
--   it. External-agent delegation really is governed, by a double-sided
--   allowlist — `internal_agents.integrations[].id` AND
--   `external_agents.allowed_internal_agent_ids` AND `collaboration_mode` —
--   which requires the external agent to consent, as this never did.
--
-- agent_quotas
--   Per-agent execution caps from migration 001 (max_retries, max_child_tasks,
--   max_workflow_depth, max_external_writes_per_interval, …). The tenant
--   runtime dropped its half in ITS migration 078 — "Phase 2 entitlements
--   rework: strip capacity cap columns. Credits are the only limiter; all max*
--   capacity checks removed from admission" — taking cached_agent_quotas and
--   effective_quotas with it. This half was never dropped. The caps it appears
--   to set are really enforced by tenant_runtime_config + DELEGATION_HARD_CAPS
--   and execConfig.
--
-- SAFE TO DROP once this census reads zero in every environment:
--   agents with a non-empty delegates array
--   internal_agent_versions rows with delegates
--   agent_quotas rows
-- Then no data is lost and there is nobody to notify.
-- (scripts/audit-unreferenced-schema.ts runs that census.)
--
-- Follows migration 265's pattern: drop from the live table, keep the column on
-- internal_agent_versions so historical snapshots stay readable in their
-- original shape. That column is empty too, so this is about not rewriting
-- history rather than about preserving content.

-- Safety net: shout if the audit has gone stale between writing and running.
--
-- The census reads across every tenant, and both tables are FORCE ROW LEVEL
-- SECURITY — so off a tenant scope their policy raises 42704 and the whole
-- migration dies before it drops anything. That is exactly what happened on the
-- first run. Lifting FORCE for the length of the census is the pattern the
-- system-agent fence documents; it is restored immediately afterwards, and
-- agent_quotas needs no restore because the next statement drops it.
ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF to_regclass('public.agent_quotas') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE agent_quotas NO FORCE ROW LEVEL SECURITY';
  END IF;
END $$;

DO $$
DECLARE
  live_count INTEGER;
  quota_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO live_count
  FROM internal_agents
  WHERE delegates IS NOT NULL AND jsonb_array_length(delegates) > 0;
  IF live_count > 0 THEN
    RAISE NOTICE 'delegates drop: % agent(s) carried a non-empty delegates array — configuration is being discarded (it was never enforced)', live_count;
  END IF;

  SELECT COUNT(*) INTO quota_count
  FROM agent_quotas;
  IF quota_count > 0 THEN
    RAISE NOTICE 'agent_quotas drop: % row(s) present — caps are being discarded (they were never enforced)', quota_count;
  END IF;
END $$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

ALTER TABLE internal_agents DROP COLUMN IF EXISTS delegates;

DROP TABLE IF EXISTS agent_quotas;

-- Note: internal_agent_versions.delegates is preserved, per the 265 precedent.
-- New versions leave it empty; existing rows keep their value.
