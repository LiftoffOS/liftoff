-- Migration 135: External agent integrations shadow table
--
-- Tracks whether a tenant has external agent integrations (Claude Code, Codex)
-- configured. This is a shadow table kept in sync via webhooks from byok-proxy
-- so that platform-backend can answer "does this tenant have external agents?"
-- without making a runtime call to byok-proxy.
--
-- Populated from existing claude_code_proxy_keys data at migration time for
-- tenants that already have keys.

CREATE TABLE external_agent_integrations (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES tenants(id),
  type             TEXT        NOT NULL CHECK (type IN ('claude_code', 'codex')),
  active_key_count INTEGER     NOT NULL DEFAULT 0,
  last_synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_eai_tenant_type ON external_agent_integrations(tenant_id, type);

-- Seed from existing proxy keys so tenants with legacy keys show as configured.
-- Guard: claude_code_proxy_keys may not exist if migration 132 (byok cutover drop)
-- already ran, which is the case in any env where BYOK_PROXY_SERVICE_ENABLED=new.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'claude_code_proxy_keys') THEN
    INSERT INTO external_agent_integrations (tenant_id, type, active_key_count)
    SELECT
      tenant_id,
      'claude_code',
      COUNT(*) FILTER (WHERE status = 'active')
    FROM claude_code_proxy_keys
    WHERE deleted_at IS NULL
    GROUP BY tenant_id
    ON CONFLICT (tenant_id, type) DO NOTHING;
  END IF;
END $$;
