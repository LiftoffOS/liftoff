-- Per-minute sandbox cost attribution: anchor billing to wall-clock time.
--
-- Adds two columns to sandbox_state:
--   • last_billed_at   — the wall-clock instant up to which instance-alive
--                        time has been billed for this sandbox. The ticker
--                        bills (NOW() - last_billed_at) every minute and
--                        advances last_billed_at atomically. Crash-safe:
--                        a runtime restart picks up the unbilled gap on
--                        first tick after recovery.
--   • cost_micro_credits_total
--                      — running total of micro-credits charged for this
--                        sandbox (1 μcr = $0.000001 USD). Lets the runtime
--                        enforce per-sandbox cost ceilings without
--                        aggregating sandbox_usage_log every check.
--
-- Backfill last_billed_at = created_at so we charge the full alive time
-- since provision. For already-destroyed sandboxes we leave NULL.

ALTER TABLE sandbox_state
  ADD COLUMN IF NOT EXISTS last_billed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cost_micro_credits_total  BIGINT NOT NULL DEFAULT 0;

UPDATE sandbox_state
   SET last_billed_at = created_at
 WHERE last_billed_at IS NULL
   AND status NOT IN ('destroyed','error');

-- Set the sandbox_usage_log phase CHECK to the canonical set. Writers emit
-- one of the four lifecycle phases (provision / execute / teardown /
-- instance_alive); the four per-resource '*_alive' values remain in the
-- enum because rows written before this migration may still reference them.

DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'sandbox_usage_log'::regclass
     AND contype  = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%phase%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE sandbox_usage_log DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE sandbox_usage_log
  ADD CONSTRAINT sandbox_usage_log_phase_check
  CHECK (phase IN (
    'provision',
    'execute',
    'teardown',
    'instance_alive',
    'pty_session_alive',
    'browser_tab_alive',
    'watcher_alive',
    'bash_session_alive'
  ));

-- Per-tenant index for fast "total cost in time window" queries used by
-- entitlement enforcement.
CREATE INDEX IF NOT EXISTS idx_sandbox_usage_phase_tenant_ts
  ON sandbox_usage_log (tenant_id, phase, timestamp);
