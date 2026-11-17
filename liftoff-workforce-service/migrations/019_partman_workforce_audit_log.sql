-- Hand partition management of workforce_audit_log to pg_partman.
--
-- Migration 010 created the table with four hardcoded monthly partitions and a
-- comment calling them "Initial partitions". Nothing ever created a fifth. When
-- the last one ended, every audit write began failing with
--   no partition of relation "workforce_audit_log" found for row
-- and the writer swallows it, so the rows were lost and nothing said so. An
-- audit trail that fails silently is worse than one that fails loudly.
--
-- The intended replacement was written but never connected: an
-- `sql/02_partitions.sql` in the infrastructure repo provisions pg_partman for
-- this table, is described in that module's README as provisioning, and is
-- referenced by no Terraform, script or build step. It also names the wrong
-- control column (`created_at`; the table is partitioned by `occurred_at`), so
-- it would have failed had anything run it.
--
-- Two properties of this setup matter more than the extra partitions:
--
--   p_default_table (on by default in partman 5) creates a DEFAULT partition.
--   A row whose month has no partition lands there instead of raising, so
--   running off the end of the runway can no longer lose an audit row —
--   maintenance moves those rows into place afterwards.
--
--   infinite_time_partitions keeps maintenance creating months forever rather
--   than stopping once the premake window is full.
--
-- Partitions 2026_04..2026_07 keep their original names and stay attached.
-- partman only manages what it creates (it names children `_pYYYYMMDD`), which
-- means retention will not drop those four automatically. They are inside the
-- 84-month window regardless.
--
-- Requires table ownership to ATTACH PARTITION: this runs as the migration
-- role, which owns the table. The application role cannot do this, which is why
-- the recurring maintenance tick is a job with migration credentials rather
-- than a route on the service.

CREATE SCHEMA IF NOT EXISTS partman;
CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;

-- Start after the last hand-made partition so the existing four are untouched.
-- premake 12 keeps a year of runway ahead of the maintenance tick.
SELECT partman.create_parent(
  p_parent_table    := 'public.workforce_audit_log',
  p_control         := 'occurred_at',
  p_interval        := '1 month',
  p_type            := 'range',
  p_premake         := 12,
  p_start_partition := '2026-08-01'
);

UPDATE partman.part_config
SET
  retention                = '84 months', -- 7 years, matching the governance posture
  retention_keep_table     = false,
  infinite_time_partitions = true
WHERE parent_table = 'public.workforce_audit_log';

-- Create the initial set now rather than waiting for the first scheduled tick.
SELECT partman.run_maintenance(p_analyze := false);

COMMENT ON TABLE workforce_audit_log IS
  'Immutable audit trail. Monthly range partitions managed by pg_partman (see partman.part_config); a DEFAULT partition catches any month that maintenance has not reached yet.';
