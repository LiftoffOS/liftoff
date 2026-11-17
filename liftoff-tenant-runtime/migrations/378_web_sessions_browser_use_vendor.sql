-- Browser Use joins web_sessions as a session-capable vendor.
--
-- Two changes, both idempotent (migration 212 and 280 are already applied
-- everywhere and must not be edited).

-- 1. Widen the vendor CHECK. 212 pinned it to ('webclaw','anchor','browserbase').
--    The constraint is inline-created there, so Postgres named it
--    web_sessions_vendor_check; drop by that name and re-add rather than
--    guessing at a rename.
ALTER TABLE web_sessions DROP CONSTRAINT IF EXISTS web_sessions_vendor_check;
ALTER TABLE web_sessions
  ADD CONSTRAINT web_sessions_vendor_check
  CHECK (vendor IN ('webclaw', 'anchor', 'browserbase', 'browser_use'));

-- 2. Make one-live-session-per-thread vendor-agnostic.
--
--    280 scoped the unique index to `vendor = 'anchor'`, which was correct when
--    Anchor was the only vendor that could own a thread's browser pane. With a
--    second session vendor that predicate stops enforcing the invariant it was
--    written for: a thread could hold one live anchor session AND one live
--    browser_use session at the same time, and the pane — which renders exactly
--    one browser — would pick one and silently strand the other, still billing
--    for it until its idle timeout.
--
--    The invariant is "one live browser per thread", not "one live ANCHOR
--    browser per thread", so the vendor predicate comes off.

-- 2a. Close duplicates the widened predicate would reject, newest kept. Same
--     shape as 280's step 2, but across every vendor rather than anchor alone.
WITH dups AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id, thread_id
           ORDER BY created_at DESC
         ) AS rn
  FROM web_sessions
  WHERE closed_at IS NULL AND thread_id IS NOT NULL
)
UPDATE web_sessions
   SET closed_at = NOW(),
       closed_reason = 'migration_cleanup'
 WHERE id IN (SELECT id FROM dups WHERE rn > 1);

-- 2b. Swap the index. Rows with a NULL thread_id (web_task / fetch sessions that
--     never bind to a chat thread) stay unconstrained: NULLs are distinct in a
--     Postgres unique index, so many of them coexist per tenant, which is what
--     the fetch path needs.
DROP INDEX IF EXISTS web_sessions_one_active_per_thread;
CREATE UNIQUE INDEX web_sessions_one_active_per_thread
  ON web_sessions (tenant_id, thread_id)
  WHERE closed_at IS NULL;
