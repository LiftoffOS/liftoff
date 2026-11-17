-- migrations/010_usage_feed_v2.sql
-- Operational-attempt columns on developer_proxy_usage_log so a per-request
-- row carries the fields OpenAI/Codex usage needs (operation, lifecycle,
-- cached/cache-write/reasoning tokens, correlation). The ingestion feed reads
-- this table directly with a monotonic id cursor — no separate journal.

BEGIN;

ALTER TABLE developer_proxy_usage_log
  ADD COLUMN attempt_id           UUID,
  ADD COLUMN lifecycle_status     TEXT CHECK (lifecycle_status IN (
                                    'started', 'completed', 'failed', 'incomplete',
                                    'aborted_by_client', 'aborted_by_proxy',
                                    'timed_out', 'transport_error')),
  ADD COLUMN operation            TEXT,
  ADD COLUMN service_tier         TEXT,
  ADD COLUMN provider_request_id  TEXT,
  ADD COLUMN session_id           TEXT,
  ADD COLUMN thread_id            TEXT,
  ADD COLUMN turn_id              TEXT,
  ADD COLUMN client_request_id    TEXT,
  ADD COLUMN reasoning_tokens     BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN total_tokens         BIGINT,
  ADD COLUMN http_status          INTEGER,
  ADD COLUMN usage_completeness   TEXT CHECK (usage_completeness IN (
                                    'measured', 'estimated', 'unavailable')),
  ADD COLUMN error_category       TEXT;

-- OpenAI cache writes are nullable (Anthropic always reports one). Drop the
-- NOT NULL default on the shared cache-creation column so a missing OpenAI
-- value is not silently coerced to zero.
ALTER TABLE developer_proxy_usage_log
  ALTER COLUMN cache_creation_input_tokens DROP NOT NULL,
  ALTER COLUMN cache_creation_input_tokens DROP DEFAULT;

CREATE INDEX idx_dp_usage_log_attempt ON developer_proxy_usage_log(attempt_id, started_at);

-- Backfill existing rows. Route evidence was not stored historically, so
-- legacy rows are classified messages.create.
UPDATE developer_proxy_usage_log SET attempt_id = gen_random_uuid() WHERE attempt_id IS NULL;
UPDATE developer_proxy_usage_log SET operation = 'messages.create' WHERE operation IS NULL;
UPDATE developer_proxy_usage_log SET lifecycle_status =
  CASE status
    WHEN 'final'        THEN 'completed'
    WHEN 'disconnected' THEN 'aborted_by_client'
    WHEN 'error'        THEN 'transport_error'
    ELSE 'started'
  END
WHERE lifecycle_status IS NULL;

COMMIT;
