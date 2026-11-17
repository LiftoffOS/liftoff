-- Add reconciliation_status to invocations for tracking zero-token aborted turns.
-- 'ok'            — normal completion with valid token counts
-- 'pending'       — completed with 0 input tokens (timeout/exception) — needs Anthropic API reconciliation
-- 'reconciled'    — token counts backfilled from Anthropic Billing API
-- 'unrecoverable' — outside Anthropic's retention window or API unavailable
ALTER TABLE invocations
  ADD COLUMN reconciliation_status TEXT
    CHECK (reconciliation_status IN ('ok', 'pending', 'reconciled', 'unrecoverable'))
    DEFAULT 'ok';

-- Backfill: any completed error invocation with 0 input tokens was likely aborted before billing
UPDATE invocations
SET reconciliation_status = 'pending'
WHERE outcome = 'error'
  AND COALESCE(input_tokens, 0) = 0
  AND completed_at IS NOT NULL;

CREATE INDEX idx_invocations_reconciliation ON invocations (reconciliation_status)
  WHERE reconciliation_status = 'pending';
