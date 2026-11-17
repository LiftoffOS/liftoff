-- Migration 398: the weekly performance recap becomes opt-in for accounts that
-- never got to choose.
--
-- Migration 206 set every notification type ON by default, including
-- `weeklyDigest`, and backfilled that onto every existing account. At the time
-- that was free: while NOTIFICATION_DELIVERY_ENABLED is "false",
-- enqueueNotification returns before it writes a row and nothing is sent. The
-- stored `true` therefore records a DEFAULT, not a decision
-- anybody made.
--
-- Turning delivery on changes that. The Tuesday performance recap is the only
-- message in the system that is not a reaction to something the user's own AI
-- teams did: runDigestTick's candidate query takes any account with
-- `weeklyDigest = true` and any activity at all, independent of pending rows.
-- Flipping the switch would therefore mass-send a recap to the entire
-- user base on the first Tuesday after deploy, to people who never
-- asked for it. Every other type stays ON, because every other type is a
-- reaction to work the account itself set in motion.
--
-- Existing accounts only. The column DEFAULT from 206 is deliberately left
-- alone, so a new signup still gets a recap a week into real usage, which is
-- the point at which it has something to report. The toggle remains in
-- Settings > Communication for anyone who wants it back.

UPDATE accounts
   SET preferences = jsonb_set(
         COALESCE(preferences, '{}'::jsonb),
         '{notificationTypes,weeklyDigest}',
         'false'::jsonb,
         -- create_missing: an account whose preferences predate 206's backfill
         -- has no notificationTypes object at all. jsonb_set leaves the row
         -- untouched when an INTERMEDIATE key is missing, so those rows keep
         -- falling through to the app-level default (ON) in
         -- enqueueNotification. Seed the object first so the write lands.
         true
       )
 WHERE deleted_at IS NULL
   AND preferences ? 'notificationTypes';

-- Rows that never had a notificationTypes object: give them one carrying the
-- same shape 206 established, with weeklyDigest already off. Split from the
-- statement above because jsonb_set cannot create a nested object in one pass.
UPDATE accounts
   SET preferences = COALESCE(preferences, '{}'::jsonb) || jsonb_build_object(
         'notificationTypes', jsonb_build_object(
           'taskUpdates',  true,
           'teamActivity', true,
           'escalations',  true,
           'weeklyDigest', false
         )
       )
 WHERE deleted_at IS NULL
   AND NOT (COALESCE(preferences, '{}'::jsonb) ? 'notificationTypes');
