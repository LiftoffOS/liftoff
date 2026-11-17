-- Per-tool constraints on RESULT handling, authored by distillation.
--
-- Sibling of capability_tier (088): a per-agent policy the platform decides and
-- the tool gateway obeys, stored on the compiled instruction so it is versioned
-- with the rest of the agent's configuration.
--
-- Shape: [{ "toolName": "<aliased tool>", "requiresComplete": true }]
--
-- `requiresComplete` means the agent may only act on the WHOLE result of that
-- tool. A result too large for context is parked in the workspace and only a
-- view reaches the model; for a call that decides whether a key already exists,
-- how many records there are, or what differs between two systems, a view does
-- not give a partial answer, it gives a wrong one — everything unseen looks
-- absent. Where this is set the gateway fails the call retryably instead of
-- returning a view as a success.
--
-- Default '[]' rather than NULL so every read is a list and no caller has to
-- decide what a null policy means. An agent compiled before this existed gets
-- the empty list, which is exactly today's behaviour.

ALTER TABLE compiled_instructions
  ADD COLUMN IF NOT EXISTS result_rules JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN compiled_instructions.result_rules IS
  'Per-tool result-handling policy from distillation: [{toolName, requiresComplete}]. requiresComplete fails the call rather than returning a parked view as a success.';
