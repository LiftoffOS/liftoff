-- Allow the 'aio-sandbox-coding' template.
--
-- `code_session` runs the coding agent in a sandbox when
-- CODE_SESSION_EXECUTION=sandbox, on an image carrying the pinned vendor CLIs.
-- The template selects that image, and it was added to the TypeScript union
-- (execution-environments/types.ts) without being added here — so the first
-- real sandboxed session failed at provisioning:
--
--   sandbox workspace unavailable: sandbox_executor_transport_500:
--   new row for relation "sandbox_state" violates check constraint
--   "sandbox_state_template_check"
--
-- BOTH tables, deliberately. Migration 266 widened sandbox_state alone and left
-- sandbox_usage_log on the migration-083 set; the sandbox then provisioned,
-- became ready, ran, and only the post-execution usage_log insert failed —
-- which migration 282 had to come back and fix. Widening one table and not the
-- other reproduces that exactly, one layer later: the coding session would work
-- and its billing row would not.
--
-- The constraint is discovered by definition rather than by name because 282
-- renamed sandbox_usage_log's, and a hard-coded name would silently match
-- nothing on a database that took a different path to here.

-- sandbox_state
DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'sandbox_state'::regclass
     AND contype  = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%template%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE sandbox_state DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE sandbox_state
  ADD CONSTRAINT sandbox_state_template_check
  CHECK (template IN (
    'general-shell', 'code-development', 'data-analysis',
    'sandbox-sidecar', 'aio-sandbox', 'aio-sandbox-coding'
  ));

-- sandbox_usage_log. Partitioned by RANGE (timestamp) with the CHECK on the
-- parent, so the ALTER cascades to every monthly partition.
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
  CHECK (template IN (
    'general-shell', 'code-development', 'data-analysis',
    'sandbox-sidecar', 'aio-sandbox', 'aio-sandbox-coding'
  ));
