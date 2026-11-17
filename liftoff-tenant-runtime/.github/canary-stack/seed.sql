-- WS-10.2 — canary seed.
--
-- Minimal rows so POST /api/execution/scheduled-invoke runs a real Anthropic
-- agent turn that calls the built-in `audit_log` standard tool. Idempotent
-- (safe to re-run every canary). FK-safe order: tenants → cached_entitlements
-- → agents → compiled_instructions.
--
-- Invoked from up.sh:
--   psql "$DATABASE_URL" -v tenant_id=... -v agent_id=... -f seed.sql
--
-- No connectors are bound (integrations=[]); `audit_log` is a first-party
-- standard tool exposed unconditionally, so it still dispatches. audit_log
-- writes a real row to audit_logs — a genuine, non-stub tool result.

\set ON_ERROR_STOP on

-- 1. Tenant (threads / invocations / audit_logs FK to tenants.id).
-- external_id is UNIQUE, so a fixed literal here pins the label to whichever
-- tenant id claimed it first. When the canary ids changed (to make them RFC
-- 4122 valid) the legacy row still held 'canary-tenant', and this insert died
-- with tenants_external_id_key before the canary could run at all. Deriving the
-- label from the id keeps the two in step and leaves any earlier generation
-- parked harmlessly. ON CONFLICT (id) still makes re-runs idempotent.
INSERT INTO tenants (id, external_id)
VALUES (:'tenant_id', 'canary-tenant-' || :'tenant_id')
ON CONFLICT (id) DO NOTHING;

-- 2. Entitlements — admission requires agent_execution_allowed=true and a
--    non-'suspended' operational_status.
INSERT INTO cached_entitlements (
  tenant_id, operational_status, agent_execution_allowed,
  remaining_credits, overage_allowed, included_monthly_credits,
  overage_ceiling, entity_version
) VALUES (
  :'tenant_id', 'active', true,
  10000, true, 1000,
  0, 1
)
ON CONFLICT (tenant_id) DO UPDATE SET
  operational_status = 'active',
  agent_execution_allowed = true;

-- 3. Agent — lifecycle MUST be 'ACTIVE'. hitl_level 0 = fully autonomous (no
--    approval pause). model pinned to a cheap Anthropic model; the objective
--    forces exactly one audit_log call.
INSERT INTO agents (
  id, tenant_id, name, lifecycle, runtime_status,
  agent_type, hitl_level, model_config, trigger_config
) VALUES (
  :'agent_id', :'tenant_id', 'audit-canary', 'ACTIVE', 'IDLE',
  'agent', 0,
  '{"provider":"anthropic","modelId":"claude-haiku-4-5"}'::jsonb,
  '{"objective":"Call the audit_log tool exactly once with action=\"canary_check\" and resource_type=\"system\", then stop."}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  lifecycle = 'ACTIVE',
  runtime_status = 'IDLE',
  model_config = EXCLUDED.model_config,
  trigger_config = EXCLUDED.trigger_config;

-- 4. Active compiled instruction (getActiveInstruction hard-fails without an
--    'active' row). Empty integrations → no connector manifests loaded.
INSERT INTO compiled_instructions (
  tenant_id, agent_id, version, status, raw_input,
  system_prompt, user_instructions, integrations, capability_tier
) VALUES (
  :'tenant_id', :'agent_id', 1, 'active', '{}'::jsonb,
  'You are a compliance canary. Your only job is to call the audit_log tool exactly once with action="canary_check" and resource_type="system", then stop. Do not call any other tool and do not ask questions.',
  '', '[]'::jsonb, 'connector_only'
)
ON CONFLICT (agent_id, version) DO UPDATE SET
  status = 'active',
  system_prompt = EXCLUDED.system_prompt;
