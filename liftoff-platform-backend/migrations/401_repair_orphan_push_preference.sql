-- Migration 401: repair accounts that registered a device but never got the
-- preference that lets us send to it.
--
-- Enabling browser notifications used to be two writes from the client: POST
-- /api/push/subscriptions to register the token, then a PATCH setting
-- preferences.notificationDelivery.browser. The second could fail on its own,
-- and did — accountPreferencesSchema is .strict() and did not yet know the key,
-- so the PATCH 400'd while the token write succeeded.
--
-- The result is a live push_subscriptions row with delivery unset, which is a
-- state nothing recovers from: enqueueNotification gates push on the
-- preference, the banner hides once permission is granted so it never asks
-- again, and usePushTokenSync deliberately does not touch preferences. The
-- person granted permission, sees a registered device, and receives nothing,
-- with no error anywhere.
--
-- The register endpoint now owns both halves, so this cannot recur. This heals
-- the rows written before that.
--
-- A live token is the evidence: it is only ever created by completing the
-- browser's own permission prompt, so its existence means the person went
-- through the enable flow and meant it.
--
-- Deliberately narrow. Only accounts with a live subscription AND no browser
-- key at all are touched, so an explicit `false` — somebody who turned the
-- channel off — is left exactly as they set it. Turning off also revokes the
-- token, so those accounts have no live row here anyway; the guard is belt and
-- braces on a preference nobody should be able to overturn by accident.

UPDATE accounts a
   SET preferences = jsonb_set(
         COALESCE(a.preferences, '{}'::jsonb),
         '{notificationDelivery,browser}',
         'true'::jsonb,
         true
       )
 WHERE a.deleted_at IS NULL
   AND EXISTS (
     SELECT 1 FROM push_subscriptions p
      WHERE p.account_id = a.id AND p.revoked_at IS NULL
   )
   AND NOT (COALESCE(a.preferences, '{}'::jsonb) -> 'notificationDelivery' ? 'browser');

-- Rows with no notificationDelivery object at all cannot be reached by
-- jsonb_set above (it leaves a row untouched when an INTERMEDIATE key is
-- missing), so seed the object for them, preserving the email default.
UPDATE accounts a
   SET preferences = COALESCE(a.preferences, '{}'::jsonb) || jsonb_build_object(
         'notificationDelivery', jsonb_build_object('email', true, 'browser', true)
       )
 WHERE a.deleted_at IS NULL
   AND EXISTS (
     SELECT 1 FROM push_subscriptions p
      WHERE p.account_id = a.id AND p.revoked_at IS NULL
   )
   AND NOT (COALESCE(a.preferences, '{}'::jsonb) ? 'notificationDelivery');
