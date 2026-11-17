-- Add the `component` column to sandbox_command_audit.
--
-- audit-repository.ts's INSERT INTO sandbox_command_audit lists `component`
-- in the column tuple (computed via inferComponent(toolName) — shell/file/
-- browser/vscode/etc.), but the original migration 083 table definition
-- never carried it. Migration 267 added the column to a different table
-- (`sandbox_audit_log`, used by sandbox-side audit middleware) and the
-- analogous addition on sandbox_command_audit was missed.
--
-- Without it, every sandbox tool dispatch logs "Failed to write sandbox audit
-- log: column 'component' of relation 'sandbox_command_audit' does not exist".
-- The executor swallows the error (the audit isn't on the critical path
-- for tool execution), but every shell dispatch loses its command-audit
-- trail.
--
-- ADD COLUMN IF NOT EXISTS is idempotent for re-applies. No backfill —
-- the column is nullable and existing rows can stay NULL.

ALTER TABLE sandbox_command_audit
  ADD COLUMN IF NOT EXISTS component text;

CREATE INDEX IF NOT EXISTS idx_sandbox_command_audit_component
  ON sandbox_command_audit (component);
