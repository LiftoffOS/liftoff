-- Migration 013: Grant workforce_app permissions on outbox tables
--
-- Migration 011 created outbox_events and processed_events while the
-- ALTER DEFAULT PRIVILEGES from the Terraform roles setup may not have
-- been in effect. Explicitly grant the missing permissions here.
--
-- Also sets ALTER DEFAULT PRIVILEGES within the migration session so
-- all subsequent migrations automatically grant workforce_app access.

GRANT SELECT, INSERT, UPDATE, DELETE ON outbox_events TO workforce_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON processed_events TO workforce_app;

-- Belt-and-suspenders: ensure default privileges are in place for all
-- future tables created by workforce_migrate in this schema.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO workforce_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO workforce_app;
