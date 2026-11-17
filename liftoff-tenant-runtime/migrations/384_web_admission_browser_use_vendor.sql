-- The admission tables reject browser_use, so the FIRST web_fetch_advanced
-- call that reaches it would have thrown a constraint violation.
--
-- runChain calls acquireInflightSlot(vendor, ...) for every vendor it tries,
-- which inserts into web_inflight_requests, and parks callers in web_waiters
-- when the vendor pool is busy. Both were widened for firecrawl, perplexity,
-- tavily and exa as those landed (migrations 220/221/231/232) and neither was
-- widened for browser_use.
--
-- It has not fired yet only because browser_use sits LAST in buildFetchChain,
-- behind perplexity, anchor and browserbase, so nothing has reached it. That is
-- luck, not safety: a tenant with none of those connected reaches it first.
--
-- Found by auditing every CHECK constraint that mentions 'anchor' against a
-- freshly migrated database, rather than by reading migrations in order. Two
-- earlier fixes (378 web_sessions, 380 web_profiles) each widened one table on
-- a path that writes several, which is how this class keeps surviving.
--
-- web_identities is deliberately NOT widened here. It is still
-- CHECK (vendor = 'anchor'), and correctly so: rows come only from
-- web_identity_connect, which is Anchor's hosted credential-capture flow, has
-- no Browser Use equivalent, and stays anchor-gated in expose-tools. Widening a
-- constraint for a writer that does not exist would invite one.
ALTER TABLE web_inflight_requests DROP CONSTRAINT IF EXISTS web_inflight_requests_vendor_check;
ALTER TABLE web_inflight_requests
  ADD CONSTRAINT web_inflight_requests_vendor_check
  CHECK (vendor IN ('webclaw','firecrawl','perplexity','anchor','browserbase','tavily','exa','browser_use'));

ALTER TABLE web_waiters DROP CONSTRAINT IF EXISTS web_waiters_vendor_check;
ALTER TABLE web_waiters
  ADD CONSTRAINT web_waiters_vendor_check
  CHECK (vendor IN ('webclaw','firecrawl','perplexity','anchor','browserbase','tavily','exa','browser_use'));
