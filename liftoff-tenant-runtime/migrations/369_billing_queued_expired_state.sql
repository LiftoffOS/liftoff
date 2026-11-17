-- Add a terminal state for invocations the Stripe meter can no longer accept.
--
-- billing_queued arrived in migration 107 as pending|published|processed with
-- DEFAULT 'pending', which stamped every row that already existed. Those rows
-- pre-date the publish path that the column exists to track, so they can never
-- reach 'published' and there is no state that says so.
--
-- Without a terminal state the reconciliation job cannot converge: it would
-- re-select the same permanently-unbillable rows on every pass, and the pending
-- count could never be used as a health signal because it would never reach
-- zero. 'expired' means: completed, never published, and now past the 35-day
-- horizon after which Stripe refuses a meter event.

ALTER TABLE invocations
  DROP CONSTRAINT IF EXISTS invocations_billing_queued_check;

ALTER TABLE invocations
  ADD CONSTRAINT invocations_billing_queued_check
    CHECK (billing_queued IN ('pending', 'published', 'processed', 'expired'));

-- Close out the existing backlog in the same statement that makes the state
-- legal. Leaving it for the job's first run would mean the job's own selection
-- window is the only thing standing between these rows and a replay.
UPDATE invocations
   SET billing_queued = 'expired'
 WHERE billing_queued = 'pending'
   AND completed_at IS NOT NULL
   AND completed_at <= NOW() - INTERVAL '35 days';

-- The partial index from 107 covers billing_queued = 'pending'; expiring rows
-- removes them from it, which is the intent.
--
-- Invocations with completed_at IS NULL are deliberately left alone. They never
-- finished, so there is nothing to bill and 'pending' is accurate rather than
-- stale; the stalled-run reconciler owns them. The actionable signal is
-- therefore pending AND completed_at IS NOT NULL, which is exactly the set the
-- reconciliation job replays.
