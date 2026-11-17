-- Widen sandbox_usage_log.phase CHECK constraint so the lifetime-ticker can
-- record idle-period phases for PTY / browser / watcher / bash sessions.
-- The original constraint (migration 083) limited phase to 'provision' /
-- 'execute' / 'teardown'; without this widening, lifetime-ticker inserts fail.

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
    'pty_session_alive',
    'browser_tab_alive',
    'watcher_alive',
    'bash_session_alive'
  ));
