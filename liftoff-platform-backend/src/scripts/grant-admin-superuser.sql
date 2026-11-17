-- grant-admin-superuser.sql
--
-- OPTIONAL operator-convenience SUPERUSER grant. NOT required by the app.
--
-- App code requires only `BYPASSRLS` on liftoff_admin (granted by
-- migration 095_enable_rls.sql). Nothing in the runtime path needs
-- SUPERUSER:
--   - withAdminScope uses BYPASSRLS, not SUPERUSER.
--   - cascade-delete uses topological FK ordering, not
--     session_replication_role.
--   - reaper / outbox writes use the same admin pool.
-- This script exists purely so a human running `psql` as `liftoff_admin`
-- (or a per-operator role such as `operator`) can execute DDL and emergency
-- table operations without switching logins to `cloudsqlsuperuser`.
--
-- WHO must run it
--   A user with `cloudsqlsuperuser` membership (the GCP-provided role that
--   has permission to elevate other roles to SUPERUSER). The `liftoff_app`
--   role used by the Cloud Build migration runner does NOT have this
--   privilege — that is why this script lives outside migrations/ and is
--   executed manually.
--
-- FROM WHERE
--   Either:
--     a) `gcloud sql connect <instance> --user=<cloudsqlsuperuser-member>`
--        (interactive), or
--     b) `cloud-sql-proxy <instance> &` then `psql -U <member> -d <db>
--        -f src/scripts/grant-admin-superuser.sql`.
--   Do NOT run from the application's Cloud Run service account — it logs in
--   as `liftoff_app` which lacks the grant capability.
--
-- WHEN
--   Whenever an operator wants direct psql DDL convenience. Safe to skip
--   entirely. Idempotent — re-runs are safe (ALTER ROLE ... WITH SUPERUSER
--   on a role that already has SUPERUSER is a no-op).
--
-- Why not a migration
--   The migration runner connects as `liftoff_app`, which is NOT
--   `cloudsqlsuperuser` and therefore cannot execute `ALTER ROLE ... WITH
--   SUPERUSER`. Putting this in migrations/ would crash the deploy.

DO $$
BEGIN
  -- liftoff_admin is created by migration 095_enable_rls.sql.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liftoff_admin') THEN
    ALTER ROLE liftoff_admin WITH SUPERUSER;
    RAISE NOTICE 'Granted SUPERUSER to liftoff_admin';
  ELSE
    RAISE WARNING 'Role liftoff_admin does not exist — run migration 095 first';
  END IF;

  -- operator role may or may not exist depending on environment (created
  -- per-environment by the GCP CloudSQL provisioning step). Idempotent.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operator') THEN
    ALTER ROLE operator WITH SUPERUSER;
    RAISE NOTICE 'Granted SUPERUSER to operator';
  ELSE
    RAISE NOTICE 'Role operator does not exist in this database; skipping';
  END IF;
END $$;
