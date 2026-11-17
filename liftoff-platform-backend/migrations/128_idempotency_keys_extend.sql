-- migrations/128_idempotency_keys_extend.sql
-- Phase 0t — extend the idempotency_keys table so the new middleware can
-- store (a) the authenticated user_id the request was made under and
-- (b) the response headers that must be replayed byte-for-byte on a
-- duplicate Idempotency-Key. Both columns are nullable for backwards
-- compatibility with existing rows.

ALTER TABLE idempotency_keys
  ADD COLUMN IF NOT EXISTS user_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS response_headers JSONB NULL;

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_user_id
  ON idempotency_keys(user_id)
  WHERE user_id IS NOT NULL;
