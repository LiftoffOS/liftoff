-- migrations/304_accounts_access_status.sql
-- Add per-user access approval state to accounts for email-level whitelisting.
-- Signup Approve/Waitlist flow: computeAccess grants when access_status='approved'
-- (checked after the domain whitelist, before invitation membership). Existing rows
-- default to 'pending' but that is inert for them — anyone already in via domain or
-- invitation stays in (those checks run first); only new non-domain signups gate here.
-- accounts has no RLS; a nullable/defaulted ADD COLUMN is a safe metadata-only change.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS access_status      TEXT NOT NULL DEFAULT 'pending'
    CHECK (access_status IN ('pending', 'approved', 'waitlisted')),
  ADD COLUMN IF NOT EXISTS access_decided_by  UUID REFERENCES accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS access_decided_at  TIMESTAMPTZ;
