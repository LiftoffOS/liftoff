-- migrations/008_grant_billing_app.sql
-- Grant billing_app the necessary table privileges.
--
-- The schema was created by billing_migrate (table owner) which does not
-- automatically grant privileges to billing_app. Without explicit GRANTs,
-- billing_app gets "permission denied" on all tables.
--
-- Privilege model:
--   billing_app — full DML on all operational tables; no DDL.
--   billing_readonly — SELECT only (for reporting / read replicas).
--   billing_migrate — table owner; retains all privileges by default.

BEGIN;

-- Ensure roles exist (idempotent — DO block swallows duplicate_object).
DO $$
BEGIN
  CREATE ROLE billing_app    NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE ROLE billing_readonly NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Grant sequences (needed for BIGSERIAL inserts).
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO billing_app;

-- Plans + features: read-only for billing_app (catalogue is admin-managed).
GRANT SELECT ON plans, plan_features TO billing_app, billing_readonly;

-- Core operational tables: full DML.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  subscriptions,
  subscription_items,
  invoices,
  invoice_line_items,
  meter_events,
  meter_reconciliation_log,
  payment_methods,
  payment_method_audit,
  stripe_webhook_events,
  credit_balances,
  outbox_events,
  processed_events
TO billing_app;

-- billing_readonly gets SELECT on everything above.
GRANT SELECT ON
  subscriptions,
  subscription_items,
  invoices,
  invoice_line_items,
  meter_events,
  meter_reconciliation_log,
  payment_methods,
  payment_method_audit,
  stripe_webhook_events,
  credit_balances,
  outbox_events,
  processed_events
TO billing_readonly;

-- billing_audit_log: INSERT only for billing_app (append-only; trigger
-- blocks UPDATE/DELETE). billing_readonly gets SELECT.
GRANT INSERT ON billing_audit_log TO billing_app;
GRANT SELECT ON billing_audit_log TO billing_app, billing_readonly;

-- Ensure future tables created by billing_migrate are also accessible.
ALTER DEFAULT PRIVILEGES FOR ROLE billing_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO billing_app;
ALTER DEFAULT PRIVILEGES FOR ROLE billing_migrate IN SCHEMA public
  GRANT SELECT ON TABLES TO billing_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE billing_migrate IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO billing_app;

COMMIT;
