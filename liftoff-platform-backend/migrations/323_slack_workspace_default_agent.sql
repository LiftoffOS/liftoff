-- A workspace-level fallback for "who should answer this?".
--
-- Routing is a specificity ladder: a thread binding beats a channel binding,
-- and both beat this. Without a bottom rung, the only answer to "nobody has
-- chosen yet" is the picker, which is the right prompt the first time and an
-- obstacle the twentieth — a workspace that overwhelmingly talks to one team
-- member re-answers the same question in every new conversation.
--
-- Deliberately a column on the install rather than a sentinel row in
-- slack_conversation_agents. A binding row means "this conversation belongs to
-- this team member"; the default is a property of the workspace and means
-- something weaker: "start here when nothing else says otherwise". Overloading
-- channel_id with a wildcard would make every binding query carry the
-- distinction, and the unique constraint would then be enforcing two different
-- ideas at once.
--
-- ON DELETE SET NULL, not CASCADE: deleting a team member must not take the
-- workspace install with it. The workspace falls back to the picker, which is
-- exactly the behaviour before a default was ever set.

ALTER TABLE slack_workspace_installs
  ADD COLUMN IF NOT EXISTS default_agent_id UUID REFERENCES internal_agents(id) ON DELETE SET NULL;

COMMENT ON COLUMN slack_workspace_installs.default_agent_id IS
  'Workspace-wide fallback team member, used only when no thread or channel binding matches and the bot was already addressed (a DM or an @mention). NULL means show the picker instead. Never makes the bot answer un-addressed channel traffic.';
