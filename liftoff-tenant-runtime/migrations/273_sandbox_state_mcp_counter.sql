-- Monotonic per-sandbox counter for idempotency keys on sandbox-originated MCP dispatches.
ALTER TABLE sandbox_state
  ADD COLUMN IF NOT EXISTS mcp_dispatch_counter bigint NOT NULL DEFAULT 0;
