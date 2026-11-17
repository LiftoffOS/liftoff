-- migrations/026_grant_payment_method_fingerprints.sql
--
-- Grants billing_app its DML on payment_method_fingerprints_seen, from a
-- migration that runs AFTER the table exists.
--
-- THE RULE THIS RESTORES. A migration may only reference objects that an
-- EARLIER migration created. Migration 008 carried a GRANT on this table while
-- migration 020 is what creates it, so the chain applied in order — which is
-- what a new environment does, and what the from-scratch gate now does on every
-- push — died at 008 with 42P01 and took every later migration down with it.
-- node-pg-migrate applies the pending batch in one transaction, so the failure
-- is total rather than partial.
--
-- WHY THE GRANT MOVED RATHER THAN BEING GUARDED IN PLACE. 008 was already
-- recorded in `pgmigrations` in every live database, so an edit to it runs
-- nowhere and only a rebuild would ever see the new text — the two would
-- disagree permanently and nothing would compare them. Removing the line
-- returns 008 to exactly what did run everywhere, and putting the GRANT here
-- makes both paths converge on the same privileges: a live database gets it
-- when this migration applies, a rebuilt one gets it in order.
--
-- Idempotent, and a no-op in practice on a live database: 008's
-- ALTER DEFAULT PRIVILEGES already grants billing_app DML on every table
-- billing_migrate creates afterwards, which includes this one. Stating it
-- explicitly costs nothing and removes the need to reason about default
-- privileges to know whether the grant is there.

BEGIN;

GRANT SELECT, INSERT, UPDATE ON payment_method_fingerprints_seen TO billing_app;
GRANT SELECT ON payment_method_fingerprints_seen TO billing_readonly;

COMMIT;
