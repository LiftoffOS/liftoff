-- Migration 083: Sandbox Execution Environments
--
-- Adds database support for sandboxed execution environments:
-- 1. sandbox_state — Lifecycle tracking for crash recovery and GC sweep
-- 2. sandbox_usage_log — Partitioned usage ledger for cost tracking
-- 3. sandbox_command_audit — Immutable audit trail for shell commands
-- 4. invocations.sandbox_cost_credits — Running cost counter
-- 5. credit_cost_model seed — Default sandbox pricing
--
-- Resolves: DE-001, DE-003, DE-004, DE-005, DE-007, DE-008, DE-010,
--           DE-011, DE-012, BE-002, BE-006, BE-010, SE-012, SE-014, SE-015

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Sandbox State (lifecycle tracking for crash recovery)
-- Resolved: BE-006 — persisted in DB, not just in-memory Map
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE sandbox_state (
  sandbox_id       TEXT PRIMARY KEY,
  session_id       UUID NOT NULL,
  tenant_id        UUID NOT NULL,
  agent_id         UUID NOT NULL,
  invocation_id    UUID NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('creating', 'ready', 'running', 'destroying', 'destroyed', 'error')),
  template         TEXT NOT NULL CHECK (template IN ('general-shell', 'code-development', 'data-analysis')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  destroyed_at     TIMESTAMPTZ
);

-- Index for finding active sandboxes per tenant (rate limiting, GC sweep)
CREATE INDEX idx_sandbox_state_active ON sandbox_state (tenant_id)
  WHERE status NOT IN ('destroyed', 'error');

-- Index for session lookup
CREATE INDEX idx_sandbox_state_session ON sandbox_state (session_id)
  WHERE status NOT IN ('destroyed', 'error');

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Sandbox Usage Log (partitioned, cost tracking)
-- Resolved: DE-003 (partitioning), DE-005 (RLS), DE-008 (CHECK constraints),
--           DE-012 (idempotency), BE-010 (no redundant FK), SE-015 (tenant index)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE sandbox_usage_log (
  id                UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  invocation_id     UUID NOT NULL,
  agent_id          UUID NOT NULL,
  sandbox_id        TEXT NOT NULL,

  -- What happened
  phase             TEXT NOT NULL CHECK (phase IN ('provision', 'execute', 'teardown')),
  tool_name         TEXT,

  -- Resource consumption
  cpu_millis        BIGINT NOT NULL DEFAULT 0,
  memory_mb_seconds BIGINT NOT NULL DEFAULT 0,
  egress_bytes      BIGINT NOT NULL DEFAULT 0,
  wall_clock_ms     BIGINT NOT NULL DEFAULT 0,

  -- Cost (credits, integer — single unit of account)
  credits_consumed  BIGINT NOT NULL DEFAULT 0,

  -- Metadata
  template          TEXT NOT NULL CHECK (template IN ('general-shell', 'code-development', 'data-analysis')),
  exit_code         INT,
  idempotency_key   TEXT,
  timestamp         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Single FK — no redundant constraint (Resolved: BE-010)
  CONSTRAINT fk_sandbox_usage_invocation FOREIGN KEY (invocation_id) REFERENCES invocations(id),

  -- Primary key includes partition column for partitioned tables
  PRIMARY KEY (id, timestamp),

  -- UNIQUE must include partition key (PostgreSQL requirement for partitioned tables)
  UNIQUE (idempotency_key, timestamp)
) PARTITION BY RANGE (timestamp);

-- Create partitions: current month + next 2 months
CREATE TABLE sandbox_usage_log_y2026m04 PARTITION OF sandbox_usage_log
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE sandbox_usage_log_y2026m05 PARTITION OF sandbox_usage_log
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE sandbox_usage_log_y2026m06 PARTITION OF sandbox_usage_log
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- Indexes (Resolved: SE-015, DE-007)
CREATE INDEX idx_sandbox_usage_tenant_ts ON sandbox_usage_log (tenant_id, timestamp);
CREATE INDEX idx_sandbox_usage_invocation ON sandbox_usage_log (invocation_id);
CREATE INDEX idx_sandbox_usage_agent_ts ON sandbox_usage_log (tenant_id, agent_id, timestamp);

-- Row Level Security (Resolved: DE-005, SE-P2-003)
ALTER TABLE sandbox_usage_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_sandbox_usage ON sandbox_usage_log
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Retention policy documented in comment
COMMENT ON TABLE sandbox_usage_log IS
  'Sandbox resource usage log. Partitioned monthly. Retention: 90d hot, archive to BigQuery after 90d, GCS Parquet after 1y.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Sandbox Command Audit (immutable, append-only)
-- Resolved: SE-012 — audit trail for individual shell commands
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE sandbox_command_audit (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  agent_id        UUID NOT NULL,
  invocation_id   UUID NOT NULL,
  sandbox_id      TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  command_args    TEXT[],
  work_dir        TEXT,
  exit_code       INT,
  stdout_preview  TEXT,
  stderr_preview  TEXT,
  wall_clock_ms   BIGINT NOT NULL DEFAULT 0,
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sandbox_audit_tenant_ts ON sandbox_command_audit (tenant_id, timestamp);
CREATE INDEX idx_sandbox_audit_invocation ON sandbox_command_audit (invocation_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Invocations Extension
-- Resolved: DE-001 — only add sandbox_cost_credits (LLM cost stays derived-on-read)
-- Resolved: DE-010 — removed tool_cost_usd (no data source)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE invocations
  ADD COLUMN sandbox_cost_credits BIGINT NOT NULL DEFAULT 0;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Credit Cost Model Seed
-- Resolved: BE-002 — use actual column names (tenant_id, connector, credits_per_action)
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO credit_cost_model (tenant_id, connector, action_type, credits_per_action)
VALUES
  (NULL, 'execution_environment', 'sandbox_provision',    5),
  (NULL, 'execution_environment', 'sandbox_exec',         2),
  (NULL, 'execution_environment', 'sandbox_teardown',     1),
  (NULL, 'execution_environment', 'sandbox_compute_sec',  1)
ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Autonomous Loop States (multi-invocation chaining for long-running tasks)
-- Tracks iteration count, budget, and completion status across invocations.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE autonomous_loop_states (
  id                   UUID PRIMARY KEY,
  tenant_id            UUID NOT NULL,
  agent_id             UUID NOT NULL,
  objective            TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed', 'stopped')),
  iteration_count      INT NOT NULL DEFAULT 0,
  max_iterations       INT NOT NULL,
  cooldown_ms          INT NOT NULL DEFAULT 60000,
  budget_credits       INT NOT NULL,
  used_credits         INT NOT NULL DEFAULT 0,
  sandbox_id           TEXT,
  last_invocation_id   UUID,
  last_outcome         TEXT,
  last_output_summary  TEXT,
  stop_reason          TEXT,
  triggered_by         TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_loop_states_active ON autonomous_loop_states (tenant_id, agent_id)
  WHERE status IN ('pending', 'running', 'paused');
CREATE INDEX idx_loop_states_needs_execution ON autonomous_loop_states (updated_at)
  WHERE status IN ('pending', 'running');
