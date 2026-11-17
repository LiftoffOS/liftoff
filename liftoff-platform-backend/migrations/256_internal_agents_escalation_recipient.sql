-- WS-3.5 — per-agent override for "who receives notifications when this agent
-- calls notifications_send without explicit recipients".
-- NULL = computed default (role:admin per D42; internal_agents has no
-- owner_account_id column today).

ALTER TABLE internal_agents
  ADD COLUMN escalation_recipient text;

COMMENT ON COLUMN internal_agents.escalation_recipient IS
  'Override for notifications_send default recipient. Formats: "user:<id>", "role:<role>", "agent:<id>". NULL = computed default (owner, admin fallback).';
