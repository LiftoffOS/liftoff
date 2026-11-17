-- audit_logs.source distinguishes LLM-loop calls from sandbox-originated calls.
-- Values: 'llm_loop' (default for existing rows), 'sandbox_code' (MCP from sandbox),
-- 'sandbox_tool' (sandbox-originated tool event), 'reflection_loop' (future reflection agent).
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'llm_loop';
ALTER TABLE audit_logs
  DROP CONSTRAINT IF EXISTS audit_logs_source_check;
ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_source_check CHECK (source IN ('llm_loop','sandbox_code','sandbox_tool','reflection_loop'));
CREATE INDEX IF NOT EXISTS idx_audit_logs_source ON audit_logs(source);
