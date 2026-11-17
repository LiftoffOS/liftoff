-- Migration 467: a consent request an un-onboarded owner can come back to.
--
-- An owner whose workspace has not finished onboarding is sent to /onboarding
-- from the consent page and returns to the SAME authorization request when
-- they are done. The request would otherwise expire ten minutes after the
-- coding tool opened it (migration 291), long before a plan and a payment
-- method are in place. The consent router parks a live request by stamping
-- this column and keeps it live for sixty minutes from that stamp; an
-- already-expired request is never revived.
--
-- oauth_authorization_requests is pre-tenant and NON-RLS (migration 291 §2b).

ALTER TABLE oauth_authorization_requests
  ADD COLUMN IF NOT EXISTS parked_for_onboarding_at TIMESTAMPTZ;

COMMENT ON COLUMN oauth_authorization_requests.parked_for_onboarding_at IS
  'Set when an owner with onboarding incomplete approved and was sent to onboarding; the request stays live for 60 minutes from this stamp.';
