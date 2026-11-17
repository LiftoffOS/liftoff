-- Migration 516: a dataset lives seven days, so a conversation resumes after
-- a weekend with its fetched data still there.
--
-- Migration 511 kept a dataset for a day, sized to "a job, not a turn". A
-- conversation is longer than a day: a person who asks for the comments on
-- Friday and for the summaries on Monday found the fetch gone and paid for
-- it again, and every turn now starts by listing the conversation's datasets
-- (the inventory), which a day-old list would leave empty.
--
-- The default moves to seven days, and the datasets alive at this migration
-- get the same seven days from when they were made, so nothing kept today
-- expires sooner than a dataset kept tomorrow. The sweep is unchanged: rows
-- past expires_at are deleted as new ones are written (datasets/store.ts).
--
-- RLS: datasets is FORCE ROW LEVEL SECURITY (511) and the migrate job connects
-- with no tenant set, so the backfill runs with FORCE dropped and restored in
-- the same transaction, as 509 does; the ALTER holds its lock until COMMIT,
-- so the policy is never observably off.

BEGIN;

ALTER TABLE datasets
  ALTER COLUMN expires_at SET DEFAULT NOW() + INTERVAL '7 days';

ALTER TABLE datasets NO FORCE ROW LEVEL SECURITY;

UPDATE datasets
   SET expires_at = created_at + INTERVAL '7 days'
 WHERE expires_at > NOW()
   AND expires_at < created_at + INTERVAL '7 days';

ALTER TABLE datasets FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN datasets.expires_at IS
  'When the dataset is swept: seven days from creation (migration 516; a day under 511), so a conversation that pauses over a weekend still holds its fetched data.';

COMMIT;
