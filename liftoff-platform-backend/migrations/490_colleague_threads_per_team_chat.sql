-- Migration 490: a team chat keeps one paired thread per colleague, not one
-- for the Chief AI Officer alone.
--
-- Migration 487 paired a team's chat with the Chief AI Officer's thread so a
-- change handed over from the chat could be previewed and applied in one
-- conversation on the Chief AI Officer's side. A team may now bring the
-- Insights Manager and Liftoff in as well, for answers, and each colleague's
-- conversation with the team's person continues the same way: its own
-- thread, paired with the team chat, created on the first ask and reused.
-- One row per (team chat, colleague); the Chief AI Officer's existing pairings
-- move in unchanged and the column they lived in goes.

CREATE TABLE IF NOT EXISTS agent_chat_colleague_threads (
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  thread_id           UUID NOT NULL REFERENCES agent_chat_threads(id) ON DELETE CASCADE,
  colleague           TEXT NOT NULL CHECK (colleague IN ('liftoff', 'caio', 'insights')),
  colleague_thread_id UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, thread_id, colleague)
);

ALTER TABLE agent_chat_colleague_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_chat_colleague_threads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_chat_colleague_threads
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- The move runs as liftoff_app, which owns the tables; FORCE is dropped for
-- the length of the transaction so the tenant policy, which reads a setting
-- no migration session has, does not refuse the rows. The read side
-- (agent_chat_threads) is FORCE too, for the same reason.
ALTER TABLE agent_chat_colleague_threads NO FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_chat_threads NO FORCE ROW LEVEL SECURITY;
INSERT INTO agent_chat_colleague_threads (tenant_id, thread_id, colleague, colleague_thread_id, created_at)
SELECT tenant_id, id, 'caio', caio_thread_id, NOW()
  FROM agent_chat_threads
 WHERE caio_thread_id IS NOT NULL
ON CONFLICT DO NOTHING;
ALTER TABLE agent_chat_threads FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_chat_colleague_threads FORCE ROW LEVEL SECURITY;

ALTER TABLE agent_chat_threads DROP COLUMN IF EXISTS caio_thread_id;

COMMENT ON TABLE agent_chat_colleague_threads IS
  'A platform assistant''s own thread paired with one team chat, per colleague, so the colleague''s conversation with the team''s person continues across the asks the team hands over.';
