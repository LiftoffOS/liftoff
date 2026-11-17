-- migrations/129_billing_cutover_drop.sql
-- Post-cutover cleanup: drop legacy billing tables from platform_backend DB.
--
-- PREREQUISITES — run ONLY after all of the following are true:
--   1. billing-cutover-runner job completed successfully (mode.json = "forwarding").
--   2. liftoff-billing service has been running for ≥ 24 h with no errors.
--   3. Replication slot `billing_logical_slot` has been removed from control-plane-pg.
--   4. platform-backend billing proxy is confirmed routing all traffic to liftoff-billing.
--   5. All billing audit log partitions have been detached from platform_backend and are
--      live in the liftoff-billing DB (verify with migration 003_partitions.sql in
--      liftoff-billing).
--
-- This migration is INTENTIONALLY NOT auto-applied by the standard migrate job.
-- Execute manually with a DBA review:
--   psql ${PLATFORM_BACKEND_DB_URL} -f migrations/129_billing_cutover_drop.sql
--
-- Safety gate: the migration aborts if any active Stripe subscription or invoice row is
-- still referenced from within platform_backend (indicating cutover is incomplete).

BEGIN;

-- ── Safety check ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  live_sub_count INT := 0;
  live_inv_count INT := 0;
BEGIN
  -- Guarded on the tables existing, and dynamic so a missing relation is not a
  -- parse error.
  --
  -- The check is about a database that MIGRATED INTO this state: it refuses to
  -- drop legacy billing tables while live rows are still in them. A database
  -- built from this chain never had them — nothing in migrations/ creates
  -- `invoices` — so reading it unconditionally raised 42P01 and made this
  -- migration unrunnable on a fresh database. That breaks the chain's ability
  -- to rebuild itself, and neither the tests nor a deploy would say so,
  -- because a long-lived database never rebuilds from zero.
  --
  -- Behaviour is unchanged wherever the tables exist, which is every database
  -- this check was written for: same counts, same refusal.
  IF to_regclass('public.subscriptions') IS NOT NULL THEN
    EXECUTE $q$SELECT COUNT(*) FROM subscriptions
                WHERE status IN ('active', 'trialing', 'past_due')$q$
      INTO live_sub_count;
  END IF;

  IF to_regclass('public.invoices') IS NOT NULL THEN
    EXECUTE $q$SELECT COUNT(*) FROM invoices
                WHERE status NOT IN ('paid', 'void', 'uncollectible')$q$
      INTO live_inv_count;
  END IF;

  IF live_sub_count > 0 OR live_inv_count > 0 THEN
    RAISE EXCEPTION
      'Cutover not complete: % active subscriptions, % open invoices still in platform_backend. '
      'Verify liftoff-billing is fully live before running this migration.',
      live_sub_count, live_inv_count;
  END IF;
END $$;

-- ── Drop billing-specific tables ──────────────────────────────────────────────
-- Order respects FK dependencies (children first).
--
-- Four tables this migration named are still used by this service —
-- `subscriptions`, `plans`, `refunds` and `meter_definitions` are live modules
-- in the source map. Only the six below are dropped.
--
-- Their DROPs are removed rather than guarded, because the drops were the
-- mistake: nothing in migrations/ ever recreates them, so a database rebuilt
-- from this chain would lack tables a migrated database has and then fail at
-- 217_subscriptions_one_active_per_account, which indexes `subscriptions`.
--
-- No effect on any database that has already run this migration.

DROP TABLE IF EXISTS meter_usage CASCADE;
DROP TABLE IF EXISTS credit_balance_ledger CASCADE;
DROP TABLE IF EXISTS credit_balances CASCADE;
DROP TABLE IF EXISTS payment_methods CASCADE;
DROP TABLE IF EXISTS invoices CASCADE;
DROP TABLE IF EXISTS stripe_webhook_events CASCADE;

-- ── Drop billing-specific indexes (in case any survived the CASCADE) ──────────
DROP INDEX IF EXISTS idx_meter_usage_account_timestamp;
DROP INDEX IF EXISTS idx_meter_usage_meter_id;
DROP INDEX IF EXISTS idx_subscriptions_account_id;
DROP INDEX IF EXISTS idx_subscriptions_stripe_sub_id;
DROP INDEX IF EXISTS idx_invoices_stripe_invoice_id;
DROP INDEX IF EXISTS idx_invoices_account_id;
DROP INDEX IF EXISTS idx_payment_methods_stripe_pm_id;
DROP INDEX IF EXISTS idx_stripe_webhook_events_stripe_event_id;
DROP INDEX IF EXISTS idx_stripe_webhook_events_unprocessed;

-- ── Remove billing columns from accounts table ────────────────────────────────
-- REMOVED: `accounts.stripe_customer_id` is still in use and is not dropped.
-- Dropping it on a fresh database would produce a column set migrated
-- databases do not have.

-- ── Record in schema_migrations, if this database has one ────────────────────
-- Vestigial, and the original comment already hedged with "(if using a
-- migrations table)". node-pg-migrate records every migration in `pgmigrations`
-- and nothing reads `schema_migrations`; it is the only write to it in all 336
-- migrations. Guarded rather than deleted so a database that does carry the
-- legacy table still gets the row it used to get.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$INSERT INTO schema_migrations (version, applied_at)
               VALUES ('129_billing_cutover_drop', NOW())
               ON CONFLICT (version) DO NOTHING$q$;
  END IF;
END $$;

COMMIT;
