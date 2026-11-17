-- Migration 350: share links for the Liftoff Insights and Liftoff chat surfaces.
--
-- /share/<id> is the one public artifact of a shared conversation and there is
-- one resolver behind it (migration 326), so every chat surface that has threads
-- people link to belongs in this table. Two more kinds, both in this database:
--
--   insights → insights_chat_threads (migration 074)
--   liftoff  → liftoff_chat_threads  (migration 348)
--
-- agent_id has to become nullable. It exists for URL reconstruction: an agent
-- chat is addressed by (agent, thread), and a team plan belongs to the seeded
-- Chief AI Officer row, so both of those kinds carry a real internal_agents id.
-- Neither new surface has one. They are platform surfaces rather than the
-- customer's AI teams, they have no row in internal_agents by design, and their
-- threads are addressed by thread id alone. NULL is the honest value; a
-- placeholder uuid would point at a row that does not describe the thread and
-- would be indistinguishable from a real reconstruction hint downstream.
--
-- The pairing CHECK keeps that from decaying into "agent_id is sometimes set":
-- exactly the kinds whose URLs contain an agent carry one, and the other two
-- never do. Every existing row is agent or team_plan with a non-null agent_id,
-- so it validates as written with no backfill.

BEGIN;

-- Dropped by lookup rather than by name, for the reason migration 326 gives for
-- the FK it dropped the same way: the name is whatever Postgres generated for
-- the inline CHECK in that migration, and a guess that is one character off
-- either fails the migration job (blocking the deploy) or, with IF EXISTS,
-- silently leaves the two-value constraint in place so every insights and
-- liftoff share fails at insert time instead.
DO $$
DECLARE
  check_name TEXT;
BEGIN
  SELECT con.conname INTO check_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'chat_share_links'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%thread_kind%';

  IF check_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE chat_share_links DROP CONSTRAINT %I', check_name);
  END IF;
END $$;

ALTER TABLE chat_share_links
  ADD CONSTRAINT chat_share_links_thread_kind_check
    CHECK (thread_kind IN ('agent', 'team_plan', 'insights', 'liftoff'));

-- The FK to internal_agents stays as it is: a NULL passes a foreign key, and the
-- column is still a real reference whenever it is populated.
ALTER TABLE chat_share_links ALTER COLUMN agent_id DROP NOT NULL;

ALTER TABLE chat_share_links
  ADD CONSTRAINT chat_share_links_agent_id_matches_kind
    CHECK ((agent_id IS NOT NULL) = (thread_kind IN ('agent', 'team_plan')));

COMMIT;
