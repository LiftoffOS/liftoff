BEGIN;

DO $$
BEGIN
  CREATE ROLE developer_proxy_app NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE ROLE developer_proxy_readonly NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO developer_proxy_app;

GRANT SELECT, INSERT, UPDATE ON byok_credentials TO developer_proxy_app;
GRANT SELECT ON byok_credentials TO developer_proxy_readonly;

GRANT SELECT, INSERT, UPDATE ON byok_usage_log TO developer_proxy_app;
GRANT SELECT ON byok_usage_log TO developer_proxy_readonly;

GRANT SELECT, INSERT, UPDATE ON outbox_events TO developer_proxy_app;

ALTER DEFAULT PRIVILEGES FOR ROLE developer_proxy_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO developer_proxy_app;
ALTER DEFAULT PRIVILEGES FOR ROLE developer_proxy_migrate IN SCHEMA public
  GRANT SELECT ON TABLES TO developer_proxy_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE developer_proxy_migrate IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO developer_proxy_app;

COMMIT;
