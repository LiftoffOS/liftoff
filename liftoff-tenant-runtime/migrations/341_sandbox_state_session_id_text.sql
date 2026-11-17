-- Finish the sandbox-handle UUID→text migration: sandbox_state.session_id.
--
-- Migration 286 moved every sandbox `invocation_id` to text because sandbox
-- tool calls identify themselves with sandbox-domain HANDLES that are not
-- always `invocations` row uuids (provisioning, sidecar callbacks, and the
-- parity/E2E test rig pass composite ids like
-- `sandbox:sandbox-0000abcd:shell_exec:1`). It did not carry the same
-- reasoning to `session_id`, which has been `UUID NOT NULL` since migration
-- 083 even though it holds a handle of exactly the same kind — the workspace
-- scope, supplied by the caller.
--
-- The mismatch fails on READ, not just on write: sandbox-state-repository's
-- getBySession does `SELECT ... WHERE session_id = $1`, so Postgres raises
-- `invalid input syntax for type uuid` while merely looking the workspace up,
-- before any row is written. It surfaces as a 500 from sandbox-executor
-- `/v2/execute` for a run whose session scope is not a uuid.
--
-- The companion code change (tool-gateway/service.ts sandboxSessionIdFor)
-- makes the runtime always supply a real run identity — a thread id or an
-- invocation id — so well-formed traffic no longer depends on this column
-- being permissive. This migration removes the type mismatch permanently, so
-- a legitimate synthetic handle of the 286 kind can never resurrect the same
-- failure on this column.
--
-- No FK and no uuid-typed join partner: session_id is only ever compared to
-- the caller-supplied handle, and the supporting index is a plain btree that
-- ALTER rebuilds automatically. Idempotent — guarded on the current type, so a
-- re-run against an already-migrated database is a no-op.

DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
        WHERE table_name = 'sandbox_state' AND column_name = 'session_id') = 'uuid' THEN
    ALTER TABLE sandbox_state ALTER COLUMN session_id TYPE text USING session_id::text;
  END IF;
END $$;
