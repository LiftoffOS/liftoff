-- Database grants for workforce_app and workforce_readonly.
-- Executed by migrate-entrypoint.sh before every node-pg-migrate run.
-- Idempotent — safe to re-run on every deployment.
--
-- This is the authoritative source for role permissions.
-- It mirrors sql/00_roles.sql in liftoff-infrastructure-gcp but runs
-- automatically as part of the migrate job so it never falls out of sync.

GRANT USAGE ON SCHEMA public TO workforce_app, workforce_readonly;

-- Cover all tables that already exist
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO workforce_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO workforce_readonly;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO workforce_app;

-- Ensure all tables created by workforce_migrate in future migrations
-- automatically inherit these permissions
ALTER DEFAULT PRIVILEGES FOR ROLE workforce_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO workforce_app;
ALTER DEFAULT PRIVILEGES FOR ROLE workforce_migrate IN SCHEMA public
  GRANT SELECT ON TABLES TO workforce_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE workforce_migrate IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO workforce_app;
