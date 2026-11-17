-- Migration 326: share links for CAIO team-plan threads as well as agent chat.
--
-- /share/<id> is the only public artifact of a shared conversation and there is
-- one resolver behind it, so both chat surfaces belong in this table rather than
-- in two tables with two URL spaces.
--
-- The thread FK has to go. Agent-chat threads are rows in agent_chat_threads in
-- this database; team-plan threads live in the `workforce` database on the same
-- instance, and Postgres cannot reference across databases. The resolve endpoint
-- already re-checks the thread on every read (threads soft-delete, so the FK was
-- never what kept a stale link from resolving) — losing it costs an integrity
-- guarantee that was decorative here and keeps one front door.
--
-- agent_id keeps its FK: the CAIO is a real internal_agents row
-- (00000000-0000-0000-0000-000000000001, seeded in migration 194), so team-plan
-- rows point at it and the column stays meaningful for URL reconstruction.
--
-- Backfill is the DEFAULT: every existing row is an agent-chat share.

BEGIN;

-- Dropped by lookup rather than by name. The name is whatever Postgres
-- generated when migration 293 declared the reference inline, and a guess that
-- is one character off either fails the migration job (blocking the deploy) or,
-- with IF EXISTS, silently leaves the constraint in place so every team-plan
-- share fails at insert time instead. Neither is worth saving three lines.
DO $$
DECLARE
  fk_name TEXT;
BEGIN
  SELECT con.conname INTO fk_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_class frel ON frel.oid = con.confrelid
  WHERE rel.relname = 'chat_share_links'
    AND frel.relname = 'agent_chat_threads'
    AND con.contype = 'f';

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE chat_share_links DROP CONSTRAINT %I', fk_name);
  END IF;
END $$;

ALTER TABLE chat_share_links
  ADD COLUMN thread_kind TEXT NOT NULL DEFAULT 'agent'
    CHECK (thread_kind IN ('agent', 'team_plan'));

COMMIT;
