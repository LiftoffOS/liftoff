-- Agent performance snapshots for tracking improvement over time
CREATE TABLE IF NOT EXISTS agent_performance_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  success_rate DECIMAL NOT NULL DEFAULT 0,
  autonomy_rate DECIMAL NOT NULL DEFAULT 0,
  escalation_rate DECIMAL NOT NULL DEFAULT 0,
  correction_rate DECIMAL NOT NULL DEFAULT 0,
  avg_cost_per_invocation DECIMAL NOT NULL DEFAULT 0,
  avg_duration_ms DECIMAL NOT NULL DEFAULT 0,
  memory_count INT NOT NULL DEFAULT 0,
  invocation_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, agent_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_perf_snapshots_agent
  ON agent_performance_snapshots(tenant_id, agent_id, period_start DESC);
