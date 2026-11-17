-- 231_web_fetch_tavily_vendor.sql
-- Extends the vendor CHECK on web_sessions / web_inflight_requests /
-- web_waiters to accept 'tavily'. Mirrors migration 221 which added
-- 'perplexity'.
--
-- BACKPORT NOTE: tavily is a vendor in the router + clients, but these
-- CHECK constraints were left at the 5-vendor list. Every Tavily
-- admission INSERT fails with CHECK 23514; the router's outer
-- try/catch absorbs it, the chain escalates to the next vendor, and
-- Tavily silently never serves traffic. This closes the gap.
--
-- web_sessions does not strictly need updating — Tavily is stateless
-- (supportsSessions() === false in tavily-client.ts) and never writes
-- web_sessions rows. Updated here anyway to keep all three constraints
-- in lockstep with the WebVendor union, matching the pattern set by
-- migrations 220 / 221.
--
-- web_profiles (migration 213) and web_identities (migration 214)
-- intentionally stay anchor-only — Tavily is stateless and never writes
-- those rows, same as firecrawl/webclaw/perplexity.

ALTER TABLE web_sessions DROP CONSTRAINT web_sessions_vendor_check;
ALTER TABLE web_sessions
  ADD CONSTRAINT web_sessions_vendor_check
  CHECK (vendor IN ('webclaw','firecrawl','perplexity','anchor','browserbase','tavily'));

ALTER TABLE web_inflight_requests DROP CONSTRAINT web_inflight_requests_vendor_check;
ALTER TABLE web_inflight_requests
  ADD CONSTRAINT web_inflight_requests_vendor_check
  CHECK (vendor IN ('webclaw','firecrawl','perplexity','anchor','browserbase','tavily'));

ALTER TABLE web_waiters DROP CONSTRAINT web_waiters_vendor_check;
ALTER TABLE web_waiters
  ADD CONSTRAINT web_waiters_vendor_check
  CHECK (vendor IN ('webclaw','firecrawl','perplexity','anchor','browserbase','tavily'));
