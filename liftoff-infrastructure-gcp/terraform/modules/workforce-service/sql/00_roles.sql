-- workforce: role triad + lockdown (plan 0g).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workforce_migrate') THEN
    CREATE ROLE workforce_migrate LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workforce_app') THEN
    CREATE ROLE workforce_app LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workforce_readonly') THEN
    CREATE ROLE workforce_readonly LOGIN;
  END IF;
END $$;

ALTER DATABASE workforce OWNER TO workforce_migrate;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE CONNECT ON DATABASE workforce FROM PUBLIC;
GRANT CONNECT ON DATABASE workforce TO workforce_app, workforce_readonly;

REVOKE CONNECT ON DATABASE billing FROM workforce_app, workforce_readonly;
REVOKE CONNECT ON DATABASE developer_proxy FROM workforce_app, workforce_readonly;
REVOKE CONNECT ON DATABASE connector_service FROM workforce_app, workforce_readonly;
REVOKE CONNECT ON DATABASE governance_engine FROM workforce_app, workforce_readonly;
REVOKE CONNECT ON DATABASE liftoff_control FROM workforce_app, workforce_readonly;

GRANT USAGE ON SCHEMA public TO workforce_app, workforce_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO workforce_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO workforce_readonly;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO workforce_app;

ALTER DEFAULT PRIVILEGES FOR ROLE workforce_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO workforce_app;
ALTER DEFAULT PRIVILEGES FOR ROLE workforce_migrate IN SCHEMA public
  GRANT SELECT ON TABLES TO workforce_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE workforce_migrate IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO workforce_app;
