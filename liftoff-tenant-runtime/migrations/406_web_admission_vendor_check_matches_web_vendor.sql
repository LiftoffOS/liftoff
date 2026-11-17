-- 406: the admission tables accept every vendor the router can try.
--
-- runChain registers a waiter and an in-flight row for EVERY vendor it tries,
-- so a vendor missing from these CHECKs fails on its first call with a
-- constraint violation before the vendor is reached. The lists were last
-- widened in 384 (browser_use); since then the router gained xai (web_x_search,
-- and now web_search for a Grok run) and routes web_deep_research to openai and
-- google, none of which these constraints allow. web_x_search has therefore
-- failed on every call since it shipped.
--
-- The lists below are the WebVendor union in src/integrations/web-fetch/types.ts,
-- and scripts/__tests__/web-admission-vendor-constraint.test.ts compares the
-- two, so the next vendor fails in CI rather than on its first live call.
ALTER TABLE web_inflight_requests DROP CONSTRAINT IF EXISTS web_inflight_requests_vendor_check;
ALTER TABLE web_inflight_requests
  ADD CONSTRAINT web_inflight_requests_vendor_check
  CHECK (vendor IN ('webclaw','firecrawl','perplexity','anchor','browserbase','tavily','exa','openai','google','browser_use','xai'));

ALTER TABLE web_waiters DROP CONSTRAINT IF EXISTS web_waiters_vendor_check;
ALTER TABLE web_waiters
  ADD CONSTRAINT web_waiters_vendor_check
  CHECK (vendor IN ('webclaw','firecrawl','perplexity','anchor','browserbase','tavily','exa','openai','google','browser_use','xai'));
