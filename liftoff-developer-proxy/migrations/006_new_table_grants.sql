-- migrations/006_new_table_grants.sql
-- Grant privileges on tables added in migration 004 to developer_proxy_app and developer_proxy_readonly.

BEGIN;

-- byok_vendor_config: read-only for developer_proxy_app (admin-managed)
GRANT SELECT ON byok_vendor_config TO developer_proxy_app, developer_proxy_readonly;

-- Rate limit buckets: full DML for developer_proxy_app (INSERT ON CONFLICT UPDATE)
GRANT SELECT, INSERT, UPDATE, DELETE ON byok_rate_limit_buckets TO developer_proxy_app;

-- Revocation cache: full DML for developer_proxy_app
GRANT SELECT, INSERT, UPDATE, DELETE ON byok_revocation_cache TO developer_proxy_app;

-- Processed events: developer_proxy_app inserts and queries; developer_proxy_readonly reads only
GRANT SELECT, INSERT ON processed_events TO developer_proxy_app;
GRANT SELECT ON processed_events TO developer_proxy_readonly;

-- Ensure future tables created by developer_proxy_migrate are also accessible
ALTER DEFAULT PRIVILEGES FOR ROLE developer_proxy_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO developer_proxy_app;
ALTER DEFAULT PRIVILEGES FOR ROLE developer_proxy_migrate IN SCHEMA public
  GRANT SELECT ON TABLES TO developer_proxy_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE developer_proxy_migrate IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO developer_proxy_app;

COMMIT;
