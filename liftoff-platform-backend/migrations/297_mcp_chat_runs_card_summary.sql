-- 297: MCP durable-run card summary. Denormalizes the HITL approval-card summary
-- (Action / Why / Details generated once at the gate in tenant-runtime,
-- hitl-card-content.ts) onto the mcp_chat_runs row when it pauses on
-- waiting_on_human, so liftoff_get_chat_reply can relay the pending action to the
-- coding tool without round-tripping to the approval store. Historical rows stay
-- NULL and the poll response simply omits them.
--
-- Additive nullable columns — safe under the migration role on Cloud SQL.
ALTER TABLE mcp_chat_runs ADD COLUMN IF NOT EXISTS action_summary TEXT NULL;
ALTER TABLE mcp_chat_runs ADD COLUMN IF NOT EXISTS why_summary TEXT NULL;
ALTER TABLE mcp_chat_runs ADD COLUMN IF NOT EXISTS detail TEXT NULL;
