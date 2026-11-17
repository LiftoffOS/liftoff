-- Migration 293: chat share links
-- One canonical share link per (tenant, thread) — the UNIQUE constraint is
-- the upsert arbiter and the tenant-leading index. agent_id is denormalized
-- for frontend URL reconstruction (threads have no agent column; see
-- migration 105) and validated against agent_chat_thread_participants at
-- create time. Threads soft-delete via deleted_at, so the resolve endpoint
-- re-checks the thread; the CASCADE only covers hard deletes.

CREATE TABLE chat_share_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES internal_agents(id),
  thread_id UUID NOT NULL REFERENCES agent_chat_threads(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES accounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, thread_id)
);

ALTER TABLE chat_share_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_share_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_share_links
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
