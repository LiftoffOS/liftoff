-- migrations/397_memories_last_used_at.sql
--
-- Adds last_used_at to memories. The scope-eviction planner (curation.ts)
-- scores recency by when a memory was last RETRIEVED, falling back to
-- created_at when it never has been -- but the column it reads was never
-- created, so pruneScope's SELECT failed on every save and scope caps were
-- never enforced. Retrieval stamps this column (fire-and-forget) from
-- memory/service.ts; NULL means "not retrieved since this column landed",
-- which the planner already treats as created_at.

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
