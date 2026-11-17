-- Migration 404: address a push device by its Firebase Installation ID.
--
-- `getToken()` is deprecated in @firebase/messaging in favour of `register()` +
-- `onRegistered()`, and firebase-admin 14 deprecates `token`/`tokens` as send
-- targets in favour of `fid`/`fids`. We were already on the old path.
--
-- The reason to move rather than wait: our stored token can go stale with no
-- symptom. usePushTokenSync only refreshes when somebody opens the app, so if a
-- browser rotates its push subscription (pushsubscriptionchange) during a
-- stretch where they never visit Liftoff, FCM keeps ACCEPTING sends against the
-- dead token — reporting success — while nothing arrives. `onRegistered()`
-- fires on exactly that event, which is what closes the hole.
--
-- FIDs and registration tokens are different identifier spaces, so existing
-- rows CANNOT be converted in place: every device has to re-register. That is
-- why this migration widens the table instead of renaming the column, and why
-- both identifiers have to work at once for as long as any device has not come
-- back yet.

BEGIN;

-- The new identifier. Nullable because a device that has not re-registered
-- still has only its legacy token.
ALTER TABLE push_subscriptions ADD COLUMN fid TEXT;

-- Partial rather than a plain UNIQUE constraint: every not-yet-migrated row has
-- fid NULL, and a bare UNIQUE would be satisfied by those anyway (NULLs are
-- distinct) but this states the intent and stays cheap while most rows are NULL.
CREATE UNIQUE INDEX push_subscriptions_fid_key
  ON push_subscriptions (fid) WHERE fid IS NOT NULL;

-- A row registered under the new flow has no legacy token at all.
ALTER TABLE push_subscriptions ALTER COLUMN fcm_token DROP NOT NULL;

-- The invariant that keeps the dual window honest. Either identifier is enough
-- to send to; neither is not. Without this, relaxing NOT NULL above would allow
-- a row that can never be a target and never be cleaned up, which is precisely
-- the class of silent hole this whole change exists to close.
ALTER TABLE push_subscriptions
  ADD CONSTRAINT push_subscriptions_has_target
  CHECK (fid IS NOT NULL OR fcm_token IS NOT NULL);

-- The hot read is listLiveTokens: account_id AND origin AND revoked_at IS NULL.
-- The original index covered only account_id, so origin was always a filter on
-- top of it. Widened while this table is being touched anyway.
DROP INDEX IF EXISTS push_subscriptions_account;

CREATE INDEX push_subscriptions_account
  ON push_subscriptions (account_id, origin) WHERE revoked_at IS NULL;

COMMIT;
