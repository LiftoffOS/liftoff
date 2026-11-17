-- 313: HITL approval card summary. Human-readable Action / Why / Details generated
-- ONCE at the gate (see src/agent-execution/hitl-card-content.ts) and stored on the
-- approval so every surface (web /dashboard/review, Slack/Teams review cards, MCP poll)
-- reads the same strings instead of re-deriving them. Historical rows stay NULL and the
-- consumers fall back to the raw pending_tool_calls rendering.
--
-- Additive nullable columns — safe under the migration role on Cloud SQL (no validated
-- FK, no NOT NULL backfill; see feedback_rls_forced_tables_migration_traps).
ALTER TABLE hitl_approval_requests ADD COLUMN IF NOT EXISTS action_summary TEXT NULL;
ALTER TABLE hitl_approval_requests ADD COLUMN IF NOT EXISTS why_summary TEXT NULL;
ALTER TABLE hitl_approval_requests ADD COLUMN IF NOT EXISTS detail TEXT NULL;
