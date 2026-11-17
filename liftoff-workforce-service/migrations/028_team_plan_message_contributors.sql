-- Migration 028: who else had a hand in a Chief AI Officer reply.
--
-- Contributor[] — { id, label } — the same shape, under the same column name,
-- as agent_chat_messages.contributors and insights_chat_messages.contributors
-- in platform-backend (its migration 493); liftoff_chat_messages answers the
-- same question with its author / author_label pair and derives the list on
-- read. One name and one shape is what lets a single frontend renderer draw
-- the attribution chips on all four surfaces; a fourth spelling here would be
-- a fourth thing to keep in step.
--
-- On the same terms as `media` (migration 023): the read path is end-to-end on
-- every surface, so a reply that brings a colleague in needs one writer and not
-- a schema change on a live table. A reply with no other contributor carries
-- the empty list.
--
-- A contributor is a colleague OTHER than the Chief AI Officer: `id` is
-- 'liftoff', 'insights' or a platform-backend internal_agents.id, and `label`
-- is the name the person saw, denormalised on purpose like author_label so a
-- renamed or deleted team never relabels a reply somebody has already read.
--
-- NOT NULL DEFAULT '[]' rather than nullable, unlike `media` beside it: every
-- reader wants a list, and a NULL meaning "nobody" is the same fact as an
-- empty one said a second way. The default backfills every historical row.
--
-- team_plan_messages is tenant-scoped through its thread and carries RLS, but
-- ADD COLUMN is a schema change rather than a row write, so it needs none of
-- the FORCE / NO FORCE handling a data migration on a policied table would.

ALTER TABLE team_plan_messages
  ADD COLUMN IF NOT EXISTS contributors JSONB NOT NULL DEFAULT '[]';

COMMENT ON COLUMN team_plan_messages.contributors IS
  'Contributor[] ({ id, label }): colleagues other than the Chief AI Officer who had a hand in the reply. Same shape and name as platform-backend''s agent_chat_messages.contributors; [] when no one else contributed.';
