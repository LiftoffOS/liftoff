-- Agent Conversation Recall (plan v13 Change 1): per-turn sender attribution.
--
-- Thread ownership is NOT the identity boundary (threads are tenant-shared
-- and can mix users); the boundary is the turn. Each chat exchange gets an
-- agent_chat_turns row keyed by the EXISTING PB turnId (chat-service "R5
-- Fix 12" — one identifier across audit correlation, persistence, and
-- recall exclusion), recording the responding agent and, when the sender is
-- an account-resolved user, their accounts.id. NULL sender = unresolved
-- Slack/Teams guest (recall unavailable for them by requirement).
--
-- Tenant-consistent composite FKs throughout. agent_chat_threads already
-- has UNIQUE (id, tenant_id) (migration 291); internal_agents gains the
-- same here so the agent FK is tenant-consistent too.

ALTER TABLE internal_agents
  ADD CONSTRAINT internal_agents_id_tenant_unique UNIQUE (id, tenant_id);

CREATE TABLE agent_chat_turns (
  id UUID PRIMARY KEY,                       -- the EXISTING PB turnId (no default; PB supplies it)
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  thread_id UUID NOT NULL,
  agent_id UUID NOT NULL,                    -- responder
  sender_account_id UUID REFERENCES accounts(id),          -- NULL = unresolved guest
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (thread_id, tenant_id)
    REFERENCES agent_chat_threads (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id, tenant_id)
    REFERENCES internal_agents (id, tenant_id),
  UNIQUE (id, tenant_id)
);
CREATE INDEX idx_turns_recall ON agent_chat_turns
  (tenant_id, agent_id, sender_account_id, created_at DESC)
  WHERE sender_account_id IS NOT NULL;
CREATE INDEX idx_turns_thread ON agent_chat_turns (thread_id);

ALTER TABLE agent_chat_messages ADD COLUMN turn_id UUID;
-- NOT VALID: a validated ADD runs an initial-check scan that SELECTs from
-- agent_chat_messages, which is already RLS-FORCED — on Cloud SQL the
-- migration role is not BYPASSRLS, so the policy's app.current_tenant_id
-- GUC (unset in a migration session) aborts the migration. The scan is
-- also redundant: turn_id is created in this migration, so every existing
-- row is NULL and satisfies the FK vacuously. New/updated rows are fully
-- enforced (RI triggers bypass row security by design). Do NOT add a
-- VALIDATE CONSTRAINT later — it re-runs the same RLS-blocked scan.
ALTER TABLE agent_chat_messages ADD CONSTRAINT agent_chat_messages_turn_fk
  FOREIGN KEY (turn_id, tenant_id) REFERENCES agent_chat_turns (id, tenant_id) NOT VALID;
CREATE INDEX idx_acm_turn ON agent_chat_messages (turn_id)
  WHERE turn_id IS NOT NULL;

-- RLS: ENABLE + FORCE + tenant policy (INV-PB-001; census entry added to
-- migrations/__tests__/200_verification.integration.test.ts).
ALTER TABLE agent_chat_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_chat_turns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_chat_turns
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
