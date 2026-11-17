-- developer_proxy: role triad + lockdown (plan 0g).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'developer_proxy_migrate') THEN
    CREATE ROLE developer_proxy_migrate LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'developer_proxy_app') THEN
    CREATE ROLE developer_proxy_app LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'developer_proxy_readonly') THEN
    CREATE ROLE developer_proxy_readonly LOGIN;
  END IF;
END $$;

ALTER DATABASE developer_proxy OWNER TO developer_proxy_migrate;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE CONNECT ON DATABASE developer_proxy FROM PUBLIC;
GRANT CONNECT ON DATABASE developer_proxy TO developer_proxy_app, developer_proxy_readonly;

-- Cross-database isolation.
REVOKE CONNECT ON DATABASE billing FROM developer_proxy_app, developer_proxy_readonly;
REVOKE CONNECT ON DATABASE connector_service FROM developer_proxy_app, developer_proxy_readonly;
REVOKE CONNECT ON DATABASE governance_engine FROM developer_proxy_app, developer_proxy_readonly;
REVOKE CONNECT ON DATABASE workforce FROM developer_proxy_app, developer_proxy_readonly;
REVOKE CONNECT ON DATABASE liftoff_control FROM developer_proxy_app, developer_proxy_readonly;

GRANT USAGE ON SCHEMA public TO developer_proxy_app, developer_proxy_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO developer_proxy_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO developer_proxy_readonly;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO developer_proxy_app;

ALTER DEFAULT PRIVILEGES FOR ROLE developer_proxy_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO developer_proxy_app;
ALTER DEFAULT PRIVILEGES FOR ROLE developer_proxy_migrate IN SCHEMA public
  GRANT SELECT ON TABLES TO developer_proxy_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE developer_proxy_migrate IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO developer_proxy_app;
