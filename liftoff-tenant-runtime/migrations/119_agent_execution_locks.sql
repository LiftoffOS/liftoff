-- Per-agent advisory execution lock.
-- Prevents simultaneous executions of the same agent.
-- Pattern mirrors chat_turn_locks (084) and mirror_locks (085).

CREATE TABLE IF NOT EXISTS agent_execution_locks (
  tenant_id     UUID NOT NULL,
  agent_id      UUID NOT NULL,
  lock_id       UUID NOT NULL,
  acquired_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '15 minutes',
  PRIMARY KEY (tenant_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_execution_locks_expires
  ON agent_execution_locks (expires_at);

COMMENT ON TABLE agent_execution_locks IS
  'Per-agent concurrency guard. Row = live execution; expires_at in past = stale/dead.';
