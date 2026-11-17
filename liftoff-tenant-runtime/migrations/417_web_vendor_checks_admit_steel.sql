-- 417: every vendor CHECK on the web tables admits steel, and the two the
-- ratchet did not watch are brought level with what the code writes.
--
-- Four tables pin `vendor` with a hand-written list, and each list has been
-- missed on a vendor's first day: web_inflight_requests and web_waiters
-- (runChain registers a row for every vendor in a chain before calling it, so
-- a missing vendor fails before it is reached), web_sessions (the pane's row)
-- and web_profiles (the login behind "stay signed in", written in the same
-- path as the session row, so widening one without the other only moves the
-- failure; see 383).
--
-- Two of these were already wrong for a vendor that shipped:
--   - web_profiles admitted ('anchor','browser_use') while the Browserbase
--     client has written vendor = 'browserbase' profile rows since it grew the
--     pane operations. A workspace on its own Browserbase key got a session
--     row and then a constraint violation on the profile insert.
--   - web_sessions was narrowed by 378 to four vendors, dropping the ones 232
--     had admitted; the fetch path pins a follow-up call to the vendor of a
--     recorded session, so a session row for any router vendor is legitimate.
--
-- The admission tables and web_sessions take the WebVendor union in
-- src/integrations/web-fetch/types.ts; web_profiles takes PROFILE_VENDORS in
-- src/browser-sessions/session-vendor-proxy.ts. Both are compared to these
-- lists by scripts/__tests__/web-admission-vendor-constraint.test.ts, so the
-- next vendor fails in CI rather than on its first live call.
ALTER TABLE web_inflight_requests DROP CONSTRAINT IF EXISTS web_inflight_requests_vendor_check;
ALTER TABLE web_inflight_requests
  ADD CONSTRAINT web_inflight_requests_vendor_check
  CHECK (vendor IN ('webclaw','firecrawl','perplexity','anchor','browserbase','tavily','exa','openai','google','browser_use','xai','steel'));

ALTER TABLE web_waiters DROP CONSTRAINT IF EXISTS web_waiters_vendor_check;
ALTER TABLE web_waiters
  ADD CONSTRAINT web_waiters_vendor_check
  CHECK (vendor IN ('webclaw','firecrawl','perplexity','anchor','browserbase','tavily','exa','openai','google','browser_use','xai','steel'));

ALTER TABLE web_sessions DROP CONSTRAINT IF EXISTS web_sessions_vendor_check;
ALTER TABLE web_sessions
  ADD CONSTRAINT web_sessions_vendor_check
  CHECK (vendor IN ('webclaw','firecrawl','perplexity','anchor','browserbase','tavily','exa','openai','google','browser_use','xai','steel'));

ALTER TABLE web_profiles DROP CONSTRAINT IF EXISTS web_profiles_vendor_check;
ALTER TABLE web_profiles
  ADD CONSTRAINT web_profiles_vendor_check
  CHECK (vendor IN ('anchor','browserbase','steel','browser_use'));
