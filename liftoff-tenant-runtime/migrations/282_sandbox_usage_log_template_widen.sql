-- Widen the sandbox_usage_log.template CHECK to match sandbox_state.template.
--
-- Migration 266 widened sandbox_state's template enum to add 'aio-sandbox'
-- and 'sandbox-sidecar' but left sandbox_usage_log's CHECK on the original
-- migration-083 set ('general-shell', 'code-development', 'data-analysis').
-- CloudRunSandboxProvider's default template is 'aio-sandbox', so every
-- sandbox dispatch from the orchestrator writes 'aio-sandbox' into
-- sandbox_usage_log and would trip the narrower CHECK: the sandbox
-- provisions, becomes ready, and only the post-execution usage_log insert
-- fails.
--
-- sandbox_usage_log is partitioned (PARTITION BY RANGE (timestamp) in
-- migration 083) and the CHECK lives on the parent table. ALTER TABLE on
-- the parent cascades to all monthly partitions automatically — no per-
-- partition fix-up required.

DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'sandbox_usage_log'::regclass
     AND contype  = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%template%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE sandbox_usage_log DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE sandbox_usage_log
  ADD CONSTRAINT sandbox_usage_log_template_check
  CHECK (template IN ('general-shell', 'code-development', 'data-analysis', 'sandbox-sidecar', 'aio-sandbox'));
