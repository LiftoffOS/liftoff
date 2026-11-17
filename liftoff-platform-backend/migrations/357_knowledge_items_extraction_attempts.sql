-- Give a failed extraction a way back.
--
-- `runExtractionBatch` is described in two places as the backstop that retries
-- failures — subscriber.ts:162 says state stays in the row "for the hourly
-- backstop cron to retry", and the batch logs itself as a "backstop cron
-- tick". It has never retried anything. `findPendingExtraction` selects
-- `extraction_status = 'pending'` and nothing else, so the moment an item
-- lands in 'error' it is finished: no retry, no operator affordance, and a
-- library row that displays normally while holding no text.
--
-- That turns every transient failure into a permanent one, and it hides real
-- bugs: an item that lands in 'error' from, say, a connector-service 401 still
-- needs a manual UPDATE to re-enter the queue after the cause is fixed, because
-- nothing would ever pick it up again.
--
-- Retrying needs a bound, or a file that genuinely cannot be read (a PDF on a
-- Composio-managed connector, which the proxy cannot carry) becomes a request
-- every five minutes forever. This column is that bound: the batch retries an
-- errored item on an exponential backoff and stops after
-- KNOWLEDGE_EXTRACTION_MAX_ATTEMPTS, and a successful extraction resets it to
-- zero so a later resync starts fresh.

ALTER TABLE knowledge_items
  ADD COLUMN IF NOT EXISTS extraction_attempts INTEGER NOT NULL DEFAULT 0;

-- Rows already sitting in 'error' pre-date the counter. Leaving them at 0 is
-- deliberate: they were failed by a bug that is now fixed, and this gives them
-- their retries back.
COMMENT ON COLUMN knowledge_items.extraction_attempts IS
  'Consecutive failed extraction attempts. Bounds the backstop cron retry; reset to 0 on success.';
