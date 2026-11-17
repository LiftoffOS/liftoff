-- Migration 487: a team hands a change to what it IS to the Chief AI Officer.
--
-- A person tells their team, in its chat, that a workflow step is wrong or
-- that it should produce something more. Behaviour (a technique, a
-- preference) is learned at once; standing behaviour is a routine proposal
-- the person confirms; a change to the team itself had no rail at all: the
-- turn answered and nothing durable happened, while the precise rail
-- (team_update: preview → confirm → rebuild, rollback) was reachable only
-- from the Chief AI Officer, Liftoff and the dashboard.
--
-- Two columns. `proposal_kind` tells the one-open-proposal rail which accept
-- path a yes takes: a routine folds prose into guidance and redistills; a
-- design change is carried to the Chief AI Officer, who previews it in the
-- team's chat and applies it as the person on their yes. `caio_thread_id`
-- pairs a team's chat with the Chief AI Officer's own thread for it, created
-- on the first design change and reused, so the preview and the apply are one
-- conversation on its side and the confirmation handle survives between them.

ALTER TABLE agent_suggestions
  ADD COLUMN IF NOT EXISTS proposal_kind TEXT NOT NULL DEFAULT 'routine';
ALTER TABLE agent_suggestions
  ADD CONSTRAINT agent_suggestions_proposal_kind
    CHECK (proposal_kind IN ('routine', 'design')) NOT VALID;
ALTER TABLE agent_suggestions VALIDATE CONSTRAINT agent_suggestions_proposal_kind;

COMMENT ON COLUMN agent_suggestions.proposal_kind IS
  'routine: a yes folds routine_prose into the team''s guidance and redistills. design: a yes is carried to the Chief AI Officer, who applies the change as the person.';

ALTER TABLE agent_chat_threads
  ADD COLUMN IF NOT EXISTS caio_thread_id UUID;

COMMENT ON COLUMN agent_chat_threads.caio_thread_id IS
  'The Chief AI Officer''s own thread paired with this team chat, created on the first design change the team hands over and reused after; NULL until then.';
