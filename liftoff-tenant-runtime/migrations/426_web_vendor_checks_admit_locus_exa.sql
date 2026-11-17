-- 426: the admission tables and web_sessions admit locus_exa.
--
-- A second platform-tier rung on the Locus key joins the WebVendor union:
-- locus_exa (Exa's own x402 API resold per call, the overflow behind the
-- platform's Exa key). Same rule as 425: runChain registers an in-flight row
-- and a waiter for every vendor in a chain before calling it, so a vendor
-- the CHECK does not admit fails on its first call without reaching the
-- vendor; the ratchet in scripts/__tests__/web-admission-vendor-constraint
-- .test.ts compares these lists to the union. web_sessions takes the same
-- union. web_profiles is unchanged: the rung owns no stored login.
ALTER TABLE web_inflight_requests DROP CONSTRAINT IF EXISTS web_inflight_requests_vendor_check;
ALTER TABLE web_inflight_requests
  ADD CONSTRAINT web_inflight_requests_vendor_check
  CHECK (vendor IN ('webclaw','firecrawl','perplexity','anchor','browserbase','tavily','exa','openai','google','browser_use','xai','steel','browserbase_x402','locus_web','locus_exa'));

ALTER TABLE web_waiters DROP CONSTRAINT IF EXISTS web_waiters_vendor_check;
ALTER TABLE web_waiters
  ADD CONSTRAINT web_waiters_vendor_check
  CHECK (vendor IN ('webclaw','firecrawl','perplexity','anchor','browserbase','tavily','exa','openai','google','browser_use','xai','steel','browserbase_x402','locus_web','locus_exa'));

ALTER TABLE web_sessions DROP CONSTRAINT IF EXISTS web_sessions_vendor_check;
ALTER TABLE web_sessions
  ADD CONSTRAINT web_sessions_vendor_check
  CHECK (vendor IN ('webclaw','firecrawl','perplexity','anchor','browserbase','tavily','exa','openai','google','browser_use','xai','steel','browserbase_x402','locus_web','locus_exa'));
