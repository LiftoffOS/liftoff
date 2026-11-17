-- migrations/011_outbox_rls_empty_string_guard.sql
-- Guard outbox_tenant_select against empty-string GUC values.
--
-- The outbox_tenant_select policy introduced in 007 casts
-- current_setting('app.current_tenant_id', true) to UUID.  If the GUC
-- is ever set to '' (empty string rather than NULL) the cast throws
--   "invalid input syntax for type uuid: """
-- which kills the publisher's poll SELECT on affected connections.
--
-- The root cause is any set_config(..., '') call, but the defensive fix
-- here is to short-circuit the cast when the value is blank.

BEGIN;

DROP POLICY IF EXISTS outbox_tenant_select ON outbox_events;

CREATE POLICY outbox_tenant_select ON outbox_events
  FOR SELECT
  USING (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND current_setting('app.current_tenant_id', true) <> ''
    AND tenant_id = current_setting('app.current_tenant_id', true)::uuid
  );

COMMIT;
