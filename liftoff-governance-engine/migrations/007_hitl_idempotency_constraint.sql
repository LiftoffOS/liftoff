-- Fix: the partial index created in 006 (WHERE idempotency_key IS NOT NULL)
-- is not usable by ON CONFLICT (idempotency_key) — Postgres requires a
-- non-partial unique constraint for that syntax. Drop the partial index
-- and replace it with a full unique constraint.
-- NULL values still don't conflict (SQL NULL != NULL), so rows with
-- idempotency_key = NULL are unaffected.

DROP INDEX IF EXISTS hitl_approval_requests_idempotency_key_unique;

ALTER TABLE hitl_approval_requests
  ADD CONSTRAINT hitl_approval_requests_idempotency_key_unique
  UNIQUE (idempotency_key);
