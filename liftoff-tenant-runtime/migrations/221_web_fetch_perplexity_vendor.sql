-- 221_web_fetch_perplexity_vendor.sql
-- Extends the vendor CHECK on web_sessions / web_inflight_requests / web_waiters
-- to accept 'perplexity'. Mirrors migration 220 which added 'firecrawl'.
-- Migrations 213 (web_profiles) and 214 (web_identities) intentionally stay
-- anchor-only — Perplexity is stateless and never writes those rows, same as
-- firecrawl/webclaw.

ALTER TABLE web_sessions DROP CONSTRAINT web_sessions_vendor_check;
ALTER TABLE web_sessions
  ADD CONSTRAINT web_sessions_vendor_check
  CHECK (vendor IN ('webclaw','firecrawl','perplexity','anchor','browserbase'));

ALTER TABLE web_inflight_requests DROP CONSTRAINT web_inflight_requests_vendor_check;
ALTER TABLE web_inflight_requests
  ADD CONSTRAINT web_inflight_requests_vendor_check
  CHECK (vendor IN ('webclaw','firecrawl','perplexity','anchor','browserbase'));

ALTER TABLE web_waiters DROP CONSTRAINT web_waiters_vendor_check;
ALTER TABLE web_waiters
  ADD CONSTRAINT web_waiters_vendor_check
  CHECK (vendor IN ('webclaw','firecrawl','perplexity','anchor','browserbase'));
