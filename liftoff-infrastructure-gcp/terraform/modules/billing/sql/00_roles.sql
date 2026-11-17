-- billing: role triad + database lockdown (plan 0g)
-- Applied by the billing-migrate Cloud Run Job on first boot.
-- Idempotent: safe to re-apply.

-- ── Role triad ───────────────────────────────────────────────────────────────
-- Passwords are set out-of-band via google_sql_user terraform resources;
-- the CREATE ROLE statements below create the roles without password so
-- terraform retains ownership of the credential.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'billing_migrate') THEN
    CREATE ROLE billing_migrate LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'billing_app') THEN
    CREATE ROLE billing_app LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'billing_readonly') THEN
    CREATE ROLE billing_readonly LOGIN;
  END IF;
END $$;

-- billing_migrate owns the database (DDL authority).
ALTER DATABASE billing OWNER TO billing_migrate;

-- ── Lockdown per plan 0g ────────────────────────────────────────────────────
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE CONNECT ON DATABASE billing FROM PUBLIC;

GRANT CONNECT ON DATABASE billing TO billing_app, billing_readonly;

-- Cross-database isolation: billing_app / readonly cannot connect into any
-- other service's database on the shared control-plane-pg instance.
REVOKE CONNECT ON DATABASE connector_service FROM billing_app, billing_readonly;
REVOKE CONNECT ON DATABASE governance_engine FROM billing_app, billing_readonly;
REVOKE CONNECT ON DATABASE developer_proxy FROM billing_app, billing_readonly;
REVOKE CONNECT ON DATABASE workforce FROM billing_app, billing_readonly;
REVOKE CONNECT ON DATABASE liftoff_control FROM billing_app, billing_readonly;

-- Schema permissions. Migrations create the tables; billing_app gets DML,
-- billing_readonly gets SELECT only.
GRANT USAGE ON SCHEMA public TO billing_app, billing_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO billing_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO billing_readonly;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO billing_app;

-- Future tables created by billing_migrate inherit the same grants.
ALTER DEFAULT PRIVILEGES FOR ROLE billing_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO billing_app;
ALTER DEFAULT PRIVILEGES FOR ROLE billing_migrate IN SCHEMA public
  GRANT SELECT ON TABLES TO billing_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE billing_migrate IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO billing_app;

-- Superuser lockdown per plan 0g: billing_app should NEVER connect as
-- cloudsqlsuperuser. That role is break-glass only, documented in the
-- runbook.
