-- 220_web_fetch_firecrawl_vendor.sql
-- Extend the WebVendor vocabulary on the three vendor-keyed tables to include
-- 'firecrawl'. Firecrawl is stateless (never writes web_sessions, web_profiles,
-- or web_identities), but the inflight/waiter tables enumerate the union and
-- must accept the new value or admission will fail with a CHECK violation.

-- web_sessions (migration 212)
ALTER TABLE web_sessions DROP CONSTRAINT web_sessions_vendor_check;
ALTER TABLE web_sessions
  ADD CONSTRAINT web_sessions_vendor_check
  CHECK (vendor IN ('webclaw','firecrawl','anchor','browserbase'));

-- web_inflight_requests (migration 217)
ALTER TABLE web_inflight_requests DROP CONSTRAINT web_inflight_requests_vendor_check;
ALTER TABLE web_inflight_requests
  ADD CONSTRAINT web_inflight_requests_vendor_check
  CHECK (vendor IN ('webclaw','firecrawl','anchor','browserbase'));

-- web_waiters (migration 217)
ALTER TABLE web_waiters DROP CONSTRAINT web_waiters_vendor_check;
ALTER TABLE web_waiters
  ADD CONSTRAINT web_waiters_vendor_check
  CHECK (vendor IN ('webclaw','firecrawl','anchor','browserbase'));
