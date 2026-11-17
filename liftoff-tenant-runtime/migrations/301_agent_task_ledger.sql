-- §4.9 Part B: the agent's standing worklist (the "notepad").
--
-- A durable, ordered, mutable done/remaining list — keyed on (tenant_id, agent_id),
-- NOT thread_id (threads are fresh per trigger; a thread-keyed ledger would reset
-- every trigger and never carry across — defeating the cross-trigger purpose). The
-- list is the agent's own standing todo list, persisting across all its triggers.
--
-- Distinct from idempotency (machine truth about side effects): this is agent
-- intent about the plan. Surfaced into the system prompt only when non-empty, so
-- the reactive majority pays zero overhead.
--
-- Renumber on merge if 301 is taken upstream.

CREATE TABLE IF NOT EXISTS agent_task_ledger (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL,
    agent_id    UUID NOT NULL,
    seq         INTEGER NOT NULL,
    text        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'in_progress', 'done', 'abandoned')),
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, agent_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_agent_task_ledger_open
  ON agent_task_ledger (tenant_id, agent_id, seq)
  WHERE status IN ('pending', 'in_progress');
