-- migrations/207_customer_hooks.sql
--
-- Customer-extensible webhooks that fire on PreToolUse, returning a decision
-- that the SDK respects. v1 ships PreToolUse only; event_type is reserved for
-- a future PostToolUse extension.

-- Tenant-level kill switch: ops can disable all hooks for a tenant by
-- setting this to false. Per-hook `enabled` is the fine-grained toggle;
-- this is the panic button.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS customer_hooks_enabled BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS customer_hooks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  event_type      TEXT NOT NULL CHECK (event_type IN ('PreToolUse', 'PostToolUse')),
  tool_pattern    TEXT NOT NULL,
  webhook_url     TEXT NOT NULL,
  hmac_secret_ref TEXT NOT NULL,
  timeout_ms      INTEGER NOT NULL DEFAULT 2000 CHECK (timeout_ms BETWEEN 100 AND 10000),
  fail_policy     TEXT NOT NULL DEFAULT 'fail_open'
                    CHECK (fail_policy IN ('fail_open', 'fail_closed', 'escalate_to_review')),
  qps_limit       INTEGER NOT NULL DEFAULT 50 CHECK (qps_limit BETWEEN 1 AND 1000),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_hooks_tenant_event
  ON customer_hooks (tenant_id, event_type)
  WHERE enabled = true;

CREATE TRIGGER customer_hooks_updated_at
  BEFORE UPDATE ON customer_hooks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Audit table: every hook invocation recorded for internal observability.
-- Tenants check their own webhook logs; this is for our incident response.
CREATE TABLE IF NOT EXISTS customer_hook_invocations (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  hook_id              UUID NOT NULL REFERENCES customer_hooks(id) ON DELETE CASCADE,
  invocation_id        TEXT NOT NULL,
  tool_name            TEXT NOT NULL,
  decision             TEXT,
  http_status          INTEGER,
  latency_ms           INTEGER,
  error_code           TEXT,
  fail_policy_applied  TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_hook_invocations_tenant_recent
  ON customer_hook_invocations (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_customer_hook_invocations_hook_recent
  ON customer_hook_invocations (hook_id, created_at DESC);
