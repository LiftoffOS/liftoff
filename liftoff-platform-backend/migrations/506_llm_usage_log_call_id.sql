-- 506: one usage row per logical call, whatever the transport did.
--
-- The TypeSafe client (src/typesafe/client.ts) mints one call_id before its
-- first attempt and writes exactly one row when the call ends; the runtime
-- posts its own rows to POST /api/internal/usage/record with the same id, and
-- retries that POST after an ambiguous response. Both need the insert to be
-- idempotent on the id, which needs a unique index over it.
--
-- PARTIAL, over the rows that carry one. Every row the providers' streaming
-- path writes has call_id NULL, and NULLs never conflict; the insert repeats
-- the predicate (ON CONFLICT (call_id) WHERE call_id IS NOT NULL) because
-- PostgreSQL infers a partial unique index only when it does.
--
-- attempts is how many vendor attempts the call sent. vendor_request_id is the
-- vendor's own identifier for the request, when a response arrived: the one
-- value that reconciles against the vendor's records. Existing rows keep all
-- three NULL; nothing else in the table changes.

ALTER TABLE llm_usage_log
  ADD COLUMN IF NOT EXISTS call_id TEXT,
  ADD COLUMN IF NOT EXISTS attempts SMALLINT,
  ADD COLUMN IF NOT EXISTS vendor_request_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_usage_log_call_id
  ON llm_usage_log (call_id)
  WHERE call_id IS NOT NULL;

COMMENT ON COLUMN llm_usage_log.call_id IS
  'One stable id per logical call, minted by the caller before its first attempt. Inserts are idempotent on it. NULL on rows the providers'' streaming path writes.';
COMMENT ON COLUMN llm_usage_log.attempts IS
  'How many vendor attempts the logical call sent.';
COMMENT ON COLUMN llm_usage_log.vendor_request_id IS
  'The vendor''s own request identifier, when a response arrived. Reconcilable against the vendor''s usage export.';
