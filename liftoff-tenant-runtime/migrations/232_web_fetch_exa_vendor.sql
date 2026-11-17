-- 232_web_fetch_exa_vendor.sql
-- Extends the vendor CHECK on web_sessions / web_inflight_requests /
-- web_waiters to accept 'exa'. Mirrors migration 231 which added 'tavily'.
--
-- web_sessions does not strictly need updating — Exa is stateless
-- (supportsSessions() === false in exa-client.ts) and never writes
-- web_sessions rows. Updated here anyway to keep all three constraints
-- in lockstep with the WebVendor union, matching migrations 220/221/231.
--
-- web_profiles (213) and web_identities (214) intentionally stay
-- anchor-only — Exa is stateless and never writes those rows, same as
-- firecrawl/webclaw/perplexity/tavily.

ALTER TABLE web_sessions DROP CONSTRAINT web_sessions_vendor_check;
ALTER TABLE web_sessions
  ADD CONSTRAINT web_sessions_vendor_check
  CHECK (vendor IN ('webclaw','firecrawl','perplexity','anchor','browserbase','tavily','exa'));

ALTER TABLE web_inflight_requests DROP CONSTRAINT web_inflight_requests_vendor_check;
ALTER TABLE web_inflight_requests
  ADD CONSTRAINT web_inflight_requests_vendor_check
  CHECK (vendor IN ('webclaw','firecrawl','perplexity','anchor','browserbase','tavily','exa'));

ALTER TABLE web_waiters DROP CONSTRAINT web_waiters_vendor_check;
ALTER TABLE web_waiters
  ADD CONSTRAINT web_waiters_vendor_check
  CHECK (vendor IN ('webclaw','firecrawl','perplexity','anchor','browserbase','tavily','exa'));
