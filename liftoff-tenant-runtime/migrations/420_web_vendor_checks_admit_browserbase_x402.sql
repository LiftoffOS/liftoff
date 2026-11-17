-- 420: the admission tables and web_sessions admit browserbase_x402.
--
-- The Browserbase pay-per-use gateway joins the WebVendor union as the last
-- rung of the fetch and search chains. runChain registers an in-flight row
-- and a waiter for every vendor in a chain before calling it, so a vendor the
-- CHECK does not admit fails on its first call without reaching the vendor
-- (the rule 417 states; the ratchet in
-- scripts/__tests__/web-admission-vendor-constraint.test.ts compares these
-- lists to the union). web_sessions takes the same union: the fetch path pins
-- a follow-up call to the vendor of a recorded session.
--
-- web_profiles is unchanged: the gateway serves request/response calls only
-- and never owns a stored login, so it is not in PROFILE_VENDORS.
ALTER TABLE web_inflight_requests DROP CONSTRAINT IF EXISTS web_inflight_requests_vendor_check;
ALTER TABLE web_inflight_requests
  ADD CONSTRAINT web_inflight_requests_vendor_check
  CHECK (vendor IN ('webclaw','firecrawl','perplexity','anchor','browserbase','tavily','exa','openai','google','browser_use','xai','steel','browserbase_x402'));

ALTER TABLE web_waiters DROP CONSTRAINT IF EXISTS web_waiters_vendor_check;
ALTER TABLE web_waiters
  ADD CONSTRAINT web_waiters_vendor_check
  CHECK (vendor IN ('webclaw','firecrawl','perplexity','anchor','browserbase','tavily','exa','openai','google','browser_use','xai','steel','browserbase_x402'));

ALTER TABLE web_sessions DROP CONSTRAINT IF EXISTS web_sessions_vendor_check;
ALTER TABLE web_sessions
  ADD CONSTRAINT web_sessions_vendor_check
  CHECK (vendor IN ('webclaw','firecrawl','perplexity','anchor','browserbase','tavily','exa','openai','google','browser_use','xai','steel','browserbase_x402'));
