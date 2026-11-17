-- Migration 493: who else had a hand in a reply, on every chat surface.
--
-- Contributor[] — { id, label } — one shape, one column name, on the two
-- message tables platform-backend owns that had nowhere to say it. The Chief
-- AI Officer's table gains the same column in the workforce service (its own
-- migration), and liftoff_chat_messages already answers the question with the
-- `author` / `author_label` pair migration 349 added: a hand-over there is the
-- one-element case, and its API derives `contributors` from those two columns
-- rather than moving production data into a third.
--
-- A contributor is a colleague OTHER than the assistant whose surface the
-- reply is on: on team chat, each teammate the team delegated part of the
-- work to, in the order they were first brought in, or the platform
-- assistant (Liftoff, the Chief AI Officer, the Insights Manager) that wrote
-- a `colleague` row into the team's chat; on the Insights Manager, nobody
-- today. The column lands there anyway, for the reason 391 gave for
-- media: the migration is additive and free, and a surface that gains a
-- producer later gets the capability without a schema change. Only a surface
-- with a producer is wired to write it.
--
-- `label` is the display name as the person saw it, denormalised on purpose
-- like author_label: renaming or deleting a team must never relabel or blank
-- an answer somebody has already had.
--
-- NOT NULL DEFAULT '[]' rather than nullable: every reader wants a list, and
-- a NULL that means "no contributors" is the same fact as an empty one said a
-- second way. The default backfills every historical row at no cost.

ALTER TABLE agent_chat_messages    ADD COLUMN IF NOT EXISTS contributors JSONB NOT NULL DEFAULT '[]';
ALTER TABLE insights_chat_messages ADD COLUMN IF NOT EXISTS contributors JSONB NOT NULL DEFAULT '[]';

COMMENT ON COLUMN agent_chat_messages.contributors IS
  'Contributor[] ({ id, label }): colleagues other than this team who had a hand in the row - teammates it delegated part of the reply to, in the order brought in, or the platform assistant that wrote a colleague row. id is an internal_agents.id or liftoff/caio/insights; label is the name the person saw, denormalised. [] when the team answered alone.';
COMMENT ON COLUMN insights_chat_messages.contributors IS
  'Contributor[] ({ id, label }): colleagues other than the Insights Manager who had a hand in the reply. Same shape and same name as agent_chat_messages.contributors; [] on every row today.';
