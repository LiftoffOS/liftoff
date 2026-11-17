-- Per-tool result-handling policy, authored by distillation.
--
-- Sibling of capability_tier on the same table: a per-agent policy this service
-- decides and the tenant runtime obeys. It is published on the internal_agent
-- event payload and lands on compiled_instructions.result_rules over there.
--
-- Shape: [{ "toolName": "<aliased tool>", "requiresComplete": true }]
--
-- `requiresComplete` means the agent may only act on the WHOLE result of that
-- tool. A result too large for the model's context is parked in the workspace
-- and only a preview is returned; for a call that decides whether a record
-- already exists, how many there are, or what differs between two sources, a
-- preview is not a partial answer but a wrong one, because everything unseen
-- looks absent. The runtime fails such a call retryably rather than returning a
-- preview as a success.
--
-- NOT NULL DEFAULT '[]' so every read is a list: an agent distilled before this
-- existed gets the empty policy, which is exactly today's behaviour, and no
-- caller has to decide what a null policy means.

ALTER TABLE internal_agents
  ADD COLUMN IF NOT EXISTS result_rules JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN internal_agents.result_rules IS
  'Per-tool result-handling policy from distillation: [{toolName, requiresComplete}]. Published to the tenant runtime, which refuses to return a parked view as a success for these tools.';
