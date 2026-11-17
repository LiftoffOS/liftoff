-- 362: add 'deferred' to provisioning_outbox.status.
--
-- WHY THIS EXISTS. TenantService.activate() calls billing's
-- /api/internal/provision-subscription synchronously at signup, but the
-- fused-onboarding wizard (migration 260) collects payment at step 7 while
-- activate() runs at step 0. Stripe therefore rejects every self-serve signup
-- with 400 resource_missing "This customer has no attached payment source or
-- default payment method", the failure enqueues a row here, and the worker
-- spends all 10 attempts on a 30s->24h backoff over ~2 days before giving up.
-- No retry can fix it: only the user entering a card can, and that path calls
-- /subscribe directly with the plan they actually picked.
--
-- 'failed' is the wrong terminal state for that. It is the signal an operator
-- reads as "provisioning broke, intervene" -- and folding a routine signup into
-- it would make every failure count meaningless. 'deferred' says what happened:
-- provisioning was consciously not attempted further, and the onboarding
-- payment step owns it from here.
--
-- The partial unique index provisioning_outbox_unique_active covers only
-- ('pending', 'in_progress'), so deferred rows are excluded from it exactly
-- like completed/failed rows and never block a later legitimate re-enqueue.
-- No index change is needed.
--
-- Idempotent and forward-only, per the rule that produced migration 344: the
-- constraint is located by catalog lookup rather than by assuming Postgres's
-- auto-generated name, so this applies cleanly to an existing database and to a
-- from-scratch rebuild alike.

DO $$
DECLARE
  con_name TEXT;
BEGIN
  -- Drop whatever CHECK currently constrains status, by catalog lookup. The
  -- constraint in 201 was declared inline on the column, so its name is
  -- Postgres-generated; hardcoding it would be a guess.
  SELECT c.conname INTO con_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'provisioning_outbox'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%status%'
    AND pg_get_constraintdef(c.oid) ILIKE '%in_progress%'
  LIMIT 1;

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE provisioning_outbox DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE provisioning_outbox
  ADD CONSTRAINT provisioning_outbox_status_check
  CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'deferred'));

COMMENT ON COLUMN provisioning_outbox.status IS
  'pending/in_progress/completed/failed are the retry lifecycle. deferred is terminal-but-expected: the tenant has no payment method yet, so the onboarding payment step will provision via /subscribe. A deferred row is NOT an ops signal.';
