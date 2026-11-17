-- web_profiles.vendor was pinned to ('anchor') by migration 213, so the profile
-- insert that follows a browser_use session create violated
-- web_profiles_vendor_check and the whole EnsureSessionForThread RPC 500'd.
--
-- Migration 378 widened web_sessions.vendor and stopped there. That was the
-- miss: the two tables are written in the SAME transaction path — create the
-- session row, then record the profile that backs its persistent login — so
-- widening one without the other moved the failure rather than removing it.
-- The session row committed and the profile insert threw, which left a live
-- session at the vendor with no profile row to list or forget it by.
--
-- Idempotent, and 213 stays untouched: the constraint is inline-created there,
-- so Postgres named it web_profiles_vendor_check.
ALTER TABLE web_profiles DROP CONSTRAINT IF EXISTS web_profiles_vendor_check;
ALTER TABLE web_profiles
  ADD CONSTRAINT web_profiles_vendor_check
  CHECK (vendor IN ('anchor', 'browser_use'));
