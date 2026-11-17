-- Migration 288: GRANT liftoff_admin full access to every table + sequence
--
-- Durability fix for the RLS-force rollout. The admin pool connects as the
-- BYPASSRLS role `liftoff_admin` (DB_ADMIN_USER=liftoff_admin). Migration 095
-- created that role and granted it table access AT 095-TIME, but that was a
-- point-in-time GRANT: every table created by a later migration — and any table
-- owned by `cloudsqlsuperuser` rather than `liftoff_app` — was NOT covered. With
-- FORCE ROW LEVEL SECURITY enabled, the admin pool hits `permission denied for
-- table ...` (e.g. provisioning_outbox / workflow_step_executions) on exactly
-- those later/cloudsqlsuperuser-owned tables.
--
-- This migration re-grants ALL privileges on every current table + sequence AND
-- installs ALTER DEFAULT PRIVILEGES for BOTH owning roles (liftoff_app and
-- cloudsqlsuperuser) so every FUTURE table auto-grants to liftoff_admin. It must
-- be applied before FORCE is (re-)enabled. All statements are idempotent.
--
-- Runs as liftoff_app, which is a member of cloudsqlsuperuser (INHERIT) and can
-- therefore GRANT on tables owned by either role.

GRANT USAGE ON SCHEMA public TO liftoff_admin;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO liftoff_admin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO liftoff_admin;

-- Future tables/sequences, from BOTH owning roles. liftoff_app owns tables
-- created by migrations; cloudsqlsuperuser owns any table created out-of-band.
ALTER DEFAULT PRIVILEGES FOR ROLE liftoff_app IN SCHEMA public
  GRANT ALL ON TABLES TO liftoff_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE liftoff_app IN SCHEMA public
  GRANT ALL ON SEQUENCES TO liftoff_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE cloudsqlsuperuser IN SCHEMA public
  GRANT ALL ON TABLES TO liftoff_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE cloudsqlsuperuser IN SCHEMA public
  GRANT ALL ON SEQUENCES TO liftoff_admin;
