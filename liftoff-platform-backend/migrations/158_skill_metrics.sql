-- Tracks per-skill performance for each agent.
-- One row per (agent, skill). Upserted on every task via /skill-feedback.
-- skill_id is a runtime-assigned text ID (not a FK — lives in tenant runtime DB).
CREATE TABLE agent_skill_metrics (
  agent_id             UUID NOT NULL REFERENCES internal_agents(id) ON DELETE CASCADE,
  tenant_id            UUID NOT NULL,
  skill_id             TEXT NOT NULL,
  skill_name           TEXT NOT NULL,
  origin               TEXT NOT NULL DEFAULT 'distill'
                         CHECK (origin IN ('distill', 'reflection', 'hitl')),
  success_count        INT NOT NULL DEFAULT 0,
  failure_count        INT NOT NULL DEFAULT 0,
  hitl_approval_count  INT NOT NULL DEFAULT 0,
  hitl_rejection_count INT NOT NULL DEFAULT 0,
  last_used_at         TIMESTAMPTZ,
  last_refined_at      TIMESTAMPTZ,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (agent_id, skill_id)
);

CREATE INDEX idx_agent_skill_metrics_tenant ON agent_skill_metrics(tenant_id);

-- Idempotency log: one row per (agent, task) that has been processed.
-- INSERT ... ON CONFLICT DO NOTHING — if the row already exists, skip processing.
-- Prevents double-counting on reflection service retries.
CREATE TABLE skill_feedback_log (
  agent_id     UUID NOT NULL REFERENCES internal_agents(id) ON DELETE CASCADE,
  tenant_id    UUID NOT NULL,
  task_id      TEXT NOT NULL,
  processed_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (agent_id, task_id)
);
