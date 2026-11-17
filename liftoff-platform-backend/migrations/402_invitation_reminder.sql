-- Migration 402: the day-5 invitation reminder (jobs/invite-reminder-sweep.ts).
--
-- A recipient who never accepted gets one reminder ~48h before the 7-day
-- expiry. Two columns support it on tenant_invitations:
--
--   reminded_at         — the dedupe. NULL means not yet reminded; the sweep
--                         sets it once, so no recipient is reminded twice (there
--                         is no status flip here to piggyback on, unlike expiry).
--
--   reminder_token_hash — a SECOND accept token, minted for the reminder email.
--                         The original invite_token_hash is NEVER touched, so the
--                         original invitation link keeps working; the accept
--                         lookup (findInvitationByTokenHash) matches EITHER hash,
--                         so the original link and the reminder link are both
--                         valid. We only store the hash, same as the first token.

ALTER TABLE tenant_invitations
  ADD COLUMN IF NOT EXISTS reminded_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_token_hash VARCHAR(64);

-- Mirror idx_tenant_invitations_token so an accept lookup by the reminder token
-- is indexed too. Same partial predicate; also require the hash to be set, since
-- it is NULL for every invitation that has not been reminded.
CREATE INDEX IF NOT EXISTS idx_tenant_invitations_reminder_token
  ON tenant_invitations (reminder_token_hash)
  WHERE status = 'pending' AND reminder_token_hash IS NOT NULL;
