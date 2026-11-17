-- Finish the sandbox invocation_id UUID→text migration.
--
-- Sandbox tool calls identify their invocation with a sandbox-domain handle
-- that is not always a real `invocations` row uuid: provisioning, sidecar
-- callbacks, and the parity/E2E test rig all pass synthetic composite ids of
-- the form `sandbox:<sandboxId>:<tool>:<seq>` (e.g.
-- `sandbox:sandbox-0000abcd:shell_exec:1`). The newer sandbox tables were
-- already moved to `invocation_id text` with no FK to invocations
-- (migrations 267 sandbox_audit_log, 268 sandbox_pty_sessions,
-- 269 sandbox_browser_tabs, 270 sandbox_watchers, 271 sandbox_bash_sessions),
-- but the original migration-083 tables were left on `UUID`. The mismatch
-- made every sandbox write of a synthetic handle throw
-- `invalid input syntax for type uuid: "sandbox:..."`. The awaited
-- sandbox_usage_log insert (usage-repository.ts) is the fatal one — it fails
-- the whole tool call (sandbox-executor.ts:299 catch → "Sandbox tool call
-- failed"); the sandbox_command_audit insert fails silently alongside it.
--
-- This migration brings the legacy columns in line with the post-267 pattern:
-- invocation_id becomes `text` and the stale sandbox_usage_log → invocations
-- FK is dropped (the newer sandbox tables carry no such FK; sandbox runs are
-- not guaranteed to have a parent invocations row). Real-traffic uuids store
-- fine as text. Idempotent: each ALTER is guarded on the current column type.
--
-- All four tables are written from the sandbox tool-call path with
-- session.invocationId: sandbox_usage_log (usage-repository.ts),
-- sandbox_command_audit (audit-repository.ts), sandbox_state
-- (sandbox-state-repository.ts), autonomous_loop_states.last_invocation_id
-- (loop-controller.ts). sandbox_usage_log is partitioned BY RANGE (timestamp)
-- — invocation_id is not the partition key, and ALTER on the parent cascades
-- to all monthly partitions (same as migration 282).

-- 1. sandbox_usage_log: drop the FK to invocations, then widen the column.
DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'sandbox_usage_log'::regclass
     AND contype  = 'f'
     AND pg_get_constraintdef(oid) ILIKE '%invocation_id%REFERENCES invocations%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE sandbox_usage_log DROP CONSTRAINT %I', cname);
  END IF;
END $$;

DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
        WHERE table_name = 'sandbox_usage_log' AND column_name = 'invocation_id') = 'uuid' THEN
    ALTER TABLE sandbox_usage_log ALTER COLUMN invocation_id TYPE text USING invocation_id::text;
  END IF;
END $$;

-- 2. sandbox_command_audit.invocation_id UUID → text.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
        WHERE table_name = 'sandbox_command_audit' AND column_name = 'invocation_id') = 'uuid' THEN
    ALTER TABLE sandbox_command_audit ALTER COLUMN invocation_id TYPE text USING invocation_id::text;
  END IF;
END $$;

-- 3. sandbox_state.invocation_id UUID → text.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
        WHERE table_name = 'sandbox_state' AND column_name = 'invocation_id') = 'uuid' THEN
    ALTER TABLE sandbox_state ALTER COLUMN invocation_id TYPE text USING invocation_id::text;
  END IF;
END $$;

-- 4. autonomous_loop_states.last_invocation_id UUID → text.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
        WHERE table_name = 'autonomous_loop_states' AND column_name = 'last_invocation_id') = 'uuid' THEN
    ALTER TABLE autonomous_loop_states ALTER COLUMN last_invocation_id TYPE text USING last_invocation_id::text;
  END IF;
END $$;
