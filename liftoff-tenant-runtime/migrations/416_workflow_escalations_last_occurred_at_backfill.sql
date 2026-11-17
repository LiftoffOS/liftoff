-- 416: every escalation row carries last_occurred_at from its first occurrence.
--
-- createEscalation set last_occurred_at only on the dedupe UPDATE, never on the
-- INSERT, so a fresh row carried NULL until its second occurrence. Migration
-- 287 backfilled the rows that existed when the column was added and nothing
-- covered the rows inserted since. A query that orders or windows on
-- last_occurred_at therefore missed exactly the escalations that had just
-- appeared — the ones a person most needs to see.
--
-- The INSERT now stamps last_occurred_at with the same NOW() as created_at
-- (engine/escalation-helper.ts). This backfills the rows written in between.
-- A row's first occurrence is its creation, so created_at is the truthful
-- value. Idempotent: the WHERE clause makes a re-run a no-op.

UPDATE workflow_escalations
   SET last_occurred_at = created_at
 WHERE last_occurred_at IS NULL;
