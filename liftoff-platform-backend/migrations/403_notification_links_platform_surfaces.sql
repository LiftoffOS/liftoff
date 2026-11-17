-- Migration 403: notification links for the platform chat surfaces.
--
-- A notification link could only ever point at agent chat or the review queue.
-- Liftoff, Insights and the CAIO team plan are chat surfaces too — somebody
-- asks a question there and waits for an answer exactly as they do in agent
-- chat — and none of them could be linked to, so none of them could notify.
--
-- The frontend already offers to enable notifications on all four surfaces.
-- The server could only ever deliver for one of them, which is the worse half
-- of that mismatch: the offer is visible and the delivery is not.
--
-- `thread_id` referenced agent_chat_threads, so a Liftoff thread id could not
-- even be stored. chat_share_links hit this exact wall and solved it the same
-- way in migration 326: drop the foreign key, add a discriminator, and let each
-- surface's own table own its rows. Copied deliberately, including the
-- name-lookup dance, because a hardcoded constraint name is not portable across
-- databases and `IF EXISTS` on the wrong name silently leaves it in place.

BEGIN;

DO $$
DECLARE
  fk_name TEXT;
BEGIN
  SELECT con.conname INTO fk_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_class frel ON frel.oid = con.confrelid
  WHERE rel.relname = 'notification_links'
    AND frel.relname = 'agent_chat_threads'
    AND con.contype = 'f';

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE notification_links DROP CONSTRAINT %I', fk_name);
  END IF;
END $$;

-- Which surface's table thread_id belongs to. 'agent' is the default so every
-- row written before this migration keeps its meaning without a backfill.
ALTER TABLE notification_links
  ADD COLUMN surface TEXT NOT NULL DEFAULT 'agent'
    CHECK (surface IN ('agent', 'liftoff', 'insights', 'team_plan'));

-- The dedupe index has to include the surface now: two surfaces can mint the
-- same thread UUID only by accident, but destination+thread was the identity
-- and the surface is now part of it. Rebuilt rather than added to, because
-- ON CONFLICT infers an index by matching its expressions exactly.
DROP INDEX IF EXISTS notification_links_destination_key;

CREATE UNIQUE INDEX notification_links_destination_key
  ON notification_links (
    tenant_id,
    destination,
    surface,
    COALESCE(thread_id::text, ''),
    COALESCE(record_id, '')
  );

COMMIT;
