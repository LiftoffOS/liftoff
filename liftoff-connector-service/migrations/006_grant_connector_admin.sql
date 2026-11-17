-- Migration 006: Grant connector_admin access to all tables it needs.
--
-- Migration 002 created the connector_admin role with BYPASSRLS but left
-- a placeholder comment saying GRANTs would happen "during DB provisioning
-- (out of band)". Without those grants the role has no table permissions and
-- every withAdminScope call (DCR registration, OAuth state, credential ops)
-- fails with "permission denied for table X".

-- Schema usage (required to see any objects at all).
GRANT USAGE ON SCHEMA public TO connector_admin;

-- Full DML on every table the admin paths need to read/write.
-- Grouped by first-use migration for readability.

-- 001: core tables
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE connectors                  TO connector_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE connector_credentials       TO connector_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE oauth_dynamic_registrations TO connector_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tool_classification_cache   TO connector_admin;

-- 003: OAuth flow + sync stats
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE connector_oauth_states      TO connector_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE connector_sync_stats        TO connector_admin;

-- 005: idempotency keys
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE idempotency_keys            TO connector_admin;

-- Sequences: needed for any table with a SERIAL / BIGSERIAL PK.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO connector_admin;
