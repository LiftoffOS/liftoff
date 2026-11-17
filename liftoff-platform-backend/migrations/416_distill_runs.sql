-- Wall-clock telemetry for distillation.
--
-- `llm_usage_log` records tokens per LLM call but no duration, so latency can
-- only be extrapolated from an assumed tokens-per-second rate. That is not a
-- basis for deciding whether to split the pipeline, and it is not a basis for
-- telling afterwards whether the split helped.
--
-- One row per LLM call, not per distillation: the waved strategy issues six,
-- and the whole point of the comparison is which of them the person is actually
-- waiting on. `run_id` groups the calls belonging to one distillation so the
-- three deadlines can be reconstructed:
--
--   T1  first ended_at where branch = 'summary'
--   T2  ended_at where branch = 'graph'
--   T3  max(ended_at) across the run
--
-- For the single-call arm all three collapse onto the one row, which is the
-- control the comparison needs.
--
-- Deliberately NOT folded into llm_usage_log. That table is the billing and
-- cost-attribution ledger read by /insights; adding strategy/phase/branch
-- columns that are null for every other purpose would widen a hot table for one
-- experiment. This one can be dropped when the experiment ends.

CREATE TABLE IF NOT EXISTS distill_runs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Groups the calls of one distillation. Equal to the row's own id for the
  -- single-call arm; shared by all six branches in the waved arm.
  run_id                UUID NOT NULL,

  tenant_id             UUID NOT NULL,
  -- Set only on a redistill (distill_update). Null for a new-agent build,
  -- matching how the distill service already distinguishes the two.
  agent_id              UUID,
  session_id            UUID,

  -- 'distill' | 'distill_update', mirroring llm_usage_log.purpose so the two
  -- can be joined for the cost half of the comparison.
  purpose               VARCHAR(32) NOT NULL,

  -- The A/B arm. 'single' is today's one call; 'waved' is the split.
  strategy              VARCHAR(16) NOT NULL,

  -- 'wave1' | 'wave2' | 'capability' | 'single'. The capability pass runs after
  -- fan-in and can re-run branches, so it is its own phase rather than part of
  -- wave 2 (see plan section 5b).
  phase                 VARCHAR(16) NOT NULL,

  -- Which artifact this call produced. 'single' for the control arm.
  branch                VARCHAR(32) NOT NULL,

  -- 1-based, matching the existing retry loop's `attempt + 1` logging.
  attempt               INTEGER NOT NULL DEFAULT 1,

  -- Set on a SHADOW run: the run_id of the real distillation this one was run
  -- alongside to compare against. Null for real runs.
  --
  -- The shadow is a separate distillation of the same input, not another call
  -- belonging to the real one, so it gets its own run_id and points at what it
  -- shadows. Folding both under one run_id would break the invariant that
  -- run_id groups the calls of ONE distillation, and would make T1/T2/T3
  -- unreconstructable for either.
  shadow_of_run_id      UUID,

  started_at            TIMESTAMPTZ NOT NULL,
  ended_at              TIMESTAMPTZ,
  -- Stored rather than derived. The A/B queries aggregate percentiles over it,
  -- and computing an interval in every one of those invites a unit mistake.
  duration_ms           INTEGER,

  -- Which model actually served the call. Recorded rather than assumed because
  -- the cost half of the comparison runs through computeRowCost, which is
  -- provider- and model-aware, and because a fallback to a different provider
  -- mid-experiment would otherwise be invisible in the numbers.
  provider              VARCHAR(32),
  model                 VARCHAR(128),

  input_tokens          INTEGER,
  output_tokens         INTEGER,
  cache_read_tokens     INTEGER,
  cache_creation_tokens INTEGER,

  -- 'ok' | 'validation_failed' | 'truncated' | 'error'.
  -- 'truncated' is its own outcome because the max_tokens guard in
  -- distill-service refuses the whole result rather than persisting a
  -- half-written agent, and a split arm that truncates more often would
  -- otherwise be invisible behind a generic error count.
  outcome               VARCHAR(32),
  error_message         TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The comparison always slices by arm over a window.
CREATE INDEX IF NOT EXISTS distill_runs_strategy_started_idx
  ON distill_runs (strategy, started_at DESC);

-- Reconstructing one distillation's deadlines.
CREATE INDEX IF NOT EXISTS distill_runs_run_idx
  ON distill_runs (run_id);

CREATE INDEX IF NOT EXISTS distill_runs_tenant_started_idx
  ON distill_runs (tenant_id, started_at DESC);

-- Pairing a shadow back to what it shadowed.
CREATE INDEX IF NOT EXISTS distill_runs_shadow_of_idx
  ON distill_runs (shadow_of_run_id)
  WHERE shadow_of_run_id IS NOT NULL;

COMMENT ON TABLE distill_runs IS
  'Per-LLM-call wall-clock telemetry for distillation. One row per call; run_id groups the calls of one distillation. Supports the single-vs-waved A/B comparison.';

-- RLS (INV-PB-001). Every row belongs to exactly one tenant and tenant_id is
-- NOT NULL, so this is an ordinary tenant-scoped table, not a content table
-- like distillation_cache: there are no global rows to read from a non-admin
-- context, and nothing here is legitimately shared across tenants.
--
-- The writer runs inside a request with a tenant in scope (withTenantScope).
-- The A/B comparison is a cross-tenant operator read and goes through
-- withAdminScope / the platform-backend-psql job, both of which connect as
-- liftoff_admin (BYPASSRLS), so FORCE does not block the analysis.
ALTER TABLE distill_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE distill_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON distill_runs
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
