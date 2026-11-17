-- 296_mcp_chat_runs_durable_hitl.sql
--
-- Durable MCP HITL (plan mcp-chat-hitl-seam-fix §6 Part C, Option 1).
--
-- A run that pauses on a HITL approval gate is no longer a terminal,
-- reporting-only state. `waiting_on_human` becomes a real PAUSE that resolves to
-- `completed` when the operator's /dashboard/review decision drives the
-- background resume; the resume posts the continuation as the assistant message
-- and flips the run via POST /api/internal/mcp-chat-runs/settle-by-approval.
--
-- Concurrency (D2 = BLOCK — industry-aligned with LangGraph / OpenAI Agents SDK /
-- AG-UI): while an approval is pending the thread must stay occupied so a second
-- liftoff_chat turn can't FORK the run (the background resume would otherwise
-- re-enter against a conversation that has already moved on). So `waiting_on_human`
-- joins the one-active-run-per-thread partial unique index — migration 291
-- deliberately EXCLUDED it under the old (broken) terminal assumption, which freed
-- the thread immediately. A second turn on the same thread now hits the unique
-- violation and is bounced with the waiting status + a pointer to Review; reject
-- in Review frees the thread immediately, and the 24h hitl-expiry task is the
-- backstop.
--
-- The status CHECK already permits queued/running/completed/waiting_on_human/failed
-- (migration 291), so the waiting_on_human -> running -> completed lifecycle needs
-- no constraint change. Index-only: a plain DROP/CREATE on an existing table, safe
-- under the migration role on Cloud SQL (CREATE INDEX does not require BYPASSRLS;
-- see feedback_rls_forced_tables_migration_traps).

DROP INDEX IF EXISTS idx_mcp_chat_runs_one_active_per_thread;
CREATE UNIQUE INDEX idx_mcp_chat_runs_one_active_per_thread
  ON mcp_chat_runs (thread_id) WHERE status IN ('queued', 'running', 'waiting_on_human');
