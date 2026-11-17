-- agent_audit_logs.tool_call_id — the per-call join key between a tool
-- charge and the audit record of exactly that dispatch.
--
-- The tenant runtime mints one id per standard-tool dispatch: the handler
-- uses it as the usage/cost id (it becomes cost_attribution_events.action_id
-- on both booking paths) and the dispatcher stamps the same value on the
-- runtime audit row's idempotency_key, forwarded here as toolCallId on the
-- audit outbox payload. With this column,
--
--   cost_attribution_events.action_id = agent_audit_logs.tool_call_id
--
-- joins an individual web-tool or connector charge to which URL/args it ran
-- with and what came back — per call, not per invocation. Before this, a
-- web-tool cost row's action_id was a minted UUID that joined to nothing.
--
-- Nullable: connector-path audit rows (which join through the actions
-- ledger instead), legacy runtimes, and non-tool audit events all leave it
-- NULL. Partial index because the join always arrives with a concrete id.

ALTER TABLE agent_audit_logs
  ADD COLUMN IF NOT EXISTS tool_call_id UUID;

CREATE INDEX IF NOT EXISTS idx_agent_audit_logs_tool_call_id
  ON agent_audit_logs (tenant_id, tool_call_id)
  WHERE tool_call_id IS NOT NULL;

COMMENT ON COLUMN agent_audit_logs.tool_call_id IS
  'Per-dispatch id minted by the tenant runtime; equals the cost row''s action_id for tool charges. NULL for non-tool rows and legacy runtimes.';
