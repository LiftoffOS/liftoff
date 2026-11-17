-- A Slack DM or a Teams conversation can belong to a platform assistant.
--
-- The Liftoff app in a workspace answers as whichever colleague a conversation
-- is bound to, and the colleagues were teams only: the binding column is a
-- foreign key into internal_agents, and the three platform assistants — the
-- Liftoff assistant, the Chief AI Officer, the Insights Manager — are not rows
-- there. So a person who can ask any of them anything on the dashboard could
-- reach none of them from Slack or Teams, where every team is a DM away.
--
-- An assistant binding is the same row with the other column set, and a row
-- never names two colleagues: a Slack binding names exactly one, a Teams
-- conversation at most one, because a Teams conversation is recorded at
-- install time before anyone has been picked (migration 377) and that state
-- stays legal. The assistant's own conversation thread lives beside it,
-- because an assistant's threads are keyed by nothing a Slack or Teams
-- conversation carries — a team's thread is found by the Slack thread it
-- mirrors; an assistant's is found here.
--
-- The workspace default gains the same choice, so a workspace can start every
-- new DM with the Liftoff assistant.
--
-- CHECK constraints are added NOT VALID and validated in the same migration:
-- every existing row has agent_id set and assistant_kind NULL, so validation
-- is a scan that finds nothing, and adding it NOT VALID keeps the ALTER from
-- taking the stronger lock while it reads.

ALTER TABLE slack_conversation_agents
  ALTER COLUMN agent_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS assistant_kind TEXT,
  ADD COLUMN IF NOT EXISTS assistant_thread_id UUID;

ALTER TABLE slack_conversation_agents
  ADD CONSTRAINT slack_conversation_agents_one_colleague
    CHECK ((agent_id IS NULL) <> (assistant_kind IS NULL)) NOT VALID,
  ADD CONSTRAINT slack_conversation_agents_assistant_kind
    CHECK (assistant_kind IS NULL OR assistant_kind IN ('liftoff', 'caio', 'insights')) NOT VALID;
ALTER TABLE slack_conversation_agents VALIDATE CONSTRAINT slack_conversation_agents_one_colleague;
ALTER TABLE slack_conversation_agents VALIDATE CONSTRAINT slack_conversation_agents_assistant_kind;

COMMENT ON COLUMN slack_conversation_agents.assistant_kind IS
  'The platform assistant this conversation belongs to (liftoff | caio | insights) when it is not a team; exactly one of agent_id and assistant_kind is set.';
COMMENT ON COLUMN slack_conversation_agents.assistant_thread_id IS
  'The assistant''s own chat thread for this conversation, created on the first message and continued after; NULL for a team binding, whose thread is keyed on the Slack thread.';

ALTER TABLE agent_teams_conversations
  ADD COLUMN IF NOT EXISTS assistant_kind TEXT,
  ADD COLUMN IF NOT EXISTS assistant_thread_id UUID;

ALTER TABLE agent_teams_conversations
  ADD CONSTRAINT agent_teams_conversations_one_colleague
    CHECK (agent_id IS NULL OR assistant_kind IS NULL) NOT VALID,
  ADD CONSTRAINT agent_teams_conversations_assistant_kind
    CHECK (assistant_kind IS NULL OR assistant_kind IN ('liftoff', 'caio', 'insights')) NOT VALID;
ALTER TABLE agent_teams_conversations VALIDATE CONSTRAINT agent_teams_conversations_one_colleague;
ALTER TABLE agent_teams_conversations VALIDATE CONSTRAINT agent_teams_conversations_assistant_kind;

COMMENT ON COLUMN agent_teams_conversations.assistant_kind IS
  'The platform assistant this conversation belongs to (liftoff | caio | insights) when it is not a team; exactly one of agent_id and assistant_kind is set.';
COMMENT ON COLUMN agent_teams_conversations.assistant_thread_id IS
  'The assistant''s own chat thread for this conversation, created on the first message and continued after; NULL for a team binding.';

ALTER TABLE slack_workspace_installs
  ADD COLUMN IF NOT EXISTS default_assistant_kind TEXT;
ALTER TABLE slack_workspace_installs
  ADD CONSTRAINT slack_workspace_installs_default_assistant_kind
    CHECK (default_assistant_kind IS NULL OR default_assistant_kind IN ('liftoff', 'caio', 'insights')) NOT VALID,
  ADD CONSTRAINT slack_workspace_installs_one_default
    CHECK (default_agent_id IS NULL OR default_assistant_kind IS NULL) NOT VALID;
ALTER TABLE slack_workspace_installs VALIDATE CONSTRAINT slack_workspace_installs_default_assistant_kind;
ALTER TABLE slack_workspace_installs VALIDATE CONSTRAINT slack_workspace_installs_one_default;

COMMENT ON COLUMN slack_workspace_installs.default_assistant_kind IS
  'Workspace-wide fallback platform assistant, the same rung as default_agent_id and never set beside it: a workspace that starts every new DM with the Liftoff assistant names it here.';
