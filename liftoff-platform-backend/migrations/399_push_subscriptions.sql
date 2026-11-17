-- Migration 399: browser push subscriptions.
--
-- One row per (account, browser). An FCM registration token identifies a
-- browser profile on a device, not a person, so a single account legitimately
-- owns several: a laptop, a desktop, a phone.
--
-- Account-scoped rather than tenant-scoped, and therefore no RLS, matching
-- `notifications` (migration 206). A person carries their devices across every
-- workspace they belong to; binding a token to a tenant would silence them the
-- moment they switched.
--
-- `fcm_token` is UNIQUE because FCM tokens are globally unique and that
-- uniqueness is the upsert arbiter. It also encodes the shared-device case:
-- when someone signs out of a browser and a colleague signs in, FCM hands the
-- second person the SAME token. Re-registering must therefore reassign
-- account_id rather than insert, or the first person keeps receiving the
-- second person's notifications on a machine they no longer control.
--
-- `origin` exists because environments can share one Firebase project (such
-- as YOUR_WEB_PROJECT), so a token minted on dev.example.com and one minted on
-- example.com are indistinguishable from the sender's side. Recording the
-- host that registered it lets each environment send only to its own, so a dev
-- run can never surface a notification on somebody's real device. Tokens are
-- already distinct per origin; this makes the server refuse to mix them rather
-- than trusting that.
--
-- `revoked_at` is a soft delete, set on explicit unsubscribe and on the
-- UNREGISTERED error FCM returns for a token whose browser has dropped the
-- subscription. Kept rather than deleted so a token that comes back can be
-- recognised as a re-registration instead of looking brand new.

CREATE TABLE push_subscriptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  fcm_token    TEXT NOT NULL UNIQUE,
  origin       TEXT NOT NULL,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at   TIMESTAMPTZ
);

-- Hot path: every send loads one account's live tokens for one origin.
CREATE INDEX push_subscriptions_account
  ON push_subscriptions (account_id) WHERE revoked_at IS NULL;
