-- Delegation grants.
-- Controls which Claude Code keys can call liftoff_delegate_task for which agents.
-- When can_delegate = TRUE, the account's Claude Code key(s) may call
-- liftoff_delegate_task targeting that agent.
-- Managed by tenant admins via the person-assignment modal (new checkbox).

ALTER TABLE person_agent_assignments
  ADD COLUMN can_delegate BOOLEAN NOT NULL DEFAULT FALSE;
