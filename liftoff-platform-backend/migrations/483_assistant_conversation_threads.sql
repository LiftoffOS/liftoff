-- Migration 483: an assistant's conversation in a chat is remembered per
-- (conversation, assistant), not on the binding.
--
-- Migration 476 kept an assistant's thread on the binding row of the Slack
-- conversation or Teams chat it was picked for. A binding names ONE colleague
-- per conversation, so the thread survived only while that colleague was the
-- bound one. A person whose DM is bound to a team and who addresses the Chief
-- AI Officer by name got a fresh thread on every message: the CAIO asked for
-- the URL it had been given two messages earlier, and a plan could never be
-- drafted, approved and reported on in one conversation. The assistants were
-- made addressable like a team so a person could work with them from Slack
-- and Teams; a conversation that forgets itself between messages is not that.
--
-- One row per (surface, conversation, assistant): the Slack DM or thread, or
-- the Teams chat, and which assistant, with the assistant's own thread. Read
-- on every assistant turn whatever the binding says; written once, on the
-- first. The reverse index answers where a message written between turns
-- (a plan finishing minutes after the person said yes) should go.
--
-- The binding columns 476 added for this are dropped: nothing reads them once
-- this lands, and a column nothing reads advertises a behaviour that does not
-- happen. The picker's assistant_kind on the binding stays: which colleague a
-- conversation is bound to is the binding's business.

CREATE TABLE IF NOT EXISTS assistant_conversation_threads (
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  surface             TEXT NOT NULL CHECK (surface IN ('slack', 'teams')),
  -- slack: '<slack_team_id>:<channel_id>:<thread_root_ts or empty>'; teams: the conversation id
  conversation_key    TEXT NOT NULL,
  assistant_kind      TEXT NOT NULL CHECK (assistant_kind IN ('liftoff', 'caio', 'insights')),
  assistant_thread_id UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, surface, conversation_key, assistant_kind)
);

CREATE INDEX IF NOT EXISTS idx_assistant_conversation_threads_thread
  ON assistant_conversation_threads (tenant_id, assistant_thread_id);

ALTER TABLE assistant_conversation_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_conversation_threads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON assistant_conversation_threads
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE assistant_conversation_threads IS
  'The platform assistant''s own chat thread for one Slack conversation or Teams chat, per assistant, so a conversation with it continues across messages whatever the conversation is bound to.';

ALTER TABLE slack_conversation_agents DROP COLUMN IF EXISTS assistant_thread_id;
ALTER TABLE agent_teams_conversations DROP COLUMN IF EXISTS assistant_thread_id;
