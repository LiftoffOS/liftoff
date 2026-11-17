-- Migration 405: retire the legacy FCM registration token.
--
-- Migration 404 widened push_subscriptions so a device could be addressed
-- either by its Firebase Installation ID or by the registration token it was
-- already registered under, because the two identifier spaces are not
-- interchangeable and every device had to come back through the new register
-- flow. That window is over: the send path stopped reading fcm_token in the
-- commit before this one, so nothing in the codebase can target a legacy row
-- any more.
--
-- Waiting for the legacy count to reach zero on its own does not work. A
-- browser that never opens Liftoff again keeps its row forever: it is still a
-- valid target, so nothing prunes it and nothing re-registers it. The column comes out on a decision instead, and
-- this is it.
--
-- What that costs, stated plainly: anybody still holding a legacy-only row
-- stops receiving browser notifications until they next open the app, at which
-- point the client registers them by FID and they resume. Nothing else about
-- their account changes.

BEGIN;

-- Every row that has no FID: the live legacy devices described above, and the
-- already-revoked rows left behind when a device handed its token over during
-- the migration. Deleted rather than revoked, because dropping fcm_token below
-- would leave them identified by nothing at all — and a row that names no
-- device is not a record of one.
--
-- This must run before SET NOT NULL, which is what it clears the way for.
DELETE FROM push_subscriptions WHERE fid IS NULL;

-- The CHECK existed to guarantee a row was targetable while there were two ways
-- to target one. With a single identifier NOT NULL says the same thing, so the
-- constraint goes and the column carries the invariant instead.
--
-- Dropped BEFORE the column, not after: DROP COLUMN silently takes every
-- constraint that references it, so an explicit DROP CONSTRAINT afterwards
-- errors on something that no longer exists and rolls the whole migration back.
ALTER TABLE push_subscriptions DROP CONSTRAINT push_subscriptions_has_target;

-- Nothing can reach a row without an FID now, so the column's absence is the
-- honest shape. Dropping it also takes the UNIQUE constraint that came with it.
ALTER TABLE push_subscriptions DROP COLUMN fcm_token;

ALTER TABLE push_subscriptions ALTER COLUMN fid SET NOT NULL;

-- push_subscriptions_fid_key stays PARTIAL, deliberately. Its predicate is now
-- always true, so it costs nothing and covers exactly the rows a plain index
-- would. Rebuilding it plain would break the deploy rather than tidy it:
-- Postgres infers a partial index only when a statement restates the predicate,
-- so upsertSubscriptionByFid's `ON CONFLICT (fid) WHERE fid IS NOT NULL` would
-- stop matching — and during a rollout the previous revision is still serving
-- that exact statement. A cosmetic index rewrite is not worth a window where
-- every registration errors.

COMMIT;
