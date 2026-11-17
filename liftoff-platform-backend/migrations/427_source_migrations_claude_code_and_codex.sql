-- Two more sources the importer can read: Claude Code and Codex.
--
-- Migration 361 wrote `CHECK (source IN ('openclaw', 'hermes'))`, so a bundle
-- from either new adapter would be refused by the database after passing every
-- check above it. Fix forward with a new constraint rather than editing 361:
-- `pgmigrations` records filenames, so an edit to an applied file runs in no
-- database that already has it while a from-scratch rebuild gets the new text,
-- and the two then disagree forever.
--
-- The named constraint is dropped IF EXISTS and recreated, so this is
-- idempotent and safe to re-run — the same shape migrations 163 and 344 use.
--
-- These two sources are not always-on runtimes. That changes nothing in this
-- table (a migration is a migration), but it is why nothing here adds a
-- pause-or-cutover column: there is no daemon to stop.

ALTER TABLE source_migrations
  DROP CONSTRAINT IF EXISTS source_migrations_source_check;

ALTER TABLE source_migrations
  ADD CONSTRAINT source_migrations_source_check
  CHECK (source IN ('openclaw', 'hermes', 'claude-code', 'codex'));
