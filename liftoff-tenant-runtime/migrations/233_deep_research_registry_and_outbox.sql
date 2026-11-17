-- 233_deep_research_registry_and_outbox.sql
-- Persistent submission lifecycle + durable outbox for deep_research so
-- Perplexity can be re-polled when the in-process hook misses (process
-- crash, 408 ceiling, retry exhaustion). Replaces the hook-only correctness
-- path; the orphan-sweep cron in liftoff-platform-backend retires in the
-- same release.
--
-- No explicit BEGIN/COMMIT — the migration runner wraps each file in its
-- own transaction (verified: migrations 220/221/231/232 use the same
-- bare-statement style).

CREATE TABLE deep_research_submissions (
  deep_research_id      UUID PRIMARY KEY,
  submission_id         TEXT NOT NULL,
  tenant_id             UUID NOT NULL,
  agent_id              UUID,
  reasoning_effort      TEXT NOT NULL
    CHECK (reasoning_effort IN ('low','medium','high')),
  estimate_cost_micros  BIGINT NOT NULL,
  submitted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_polled_at        TIMESTAMPTZ,
  polled_count          INTEGER NOT NULL DEFAULT 0,
  -- Hook-active heartbeat. The hook's poll loop refreshes this to NOW() + 30s
  -- on every Perplexity poll iteration. The reconciler's selection predicate
  -- (TR-2 selectDueForReconciliation) skips rows where hook_active_until > NOW()
  -- so the reconciler doesn't double-poll Perplexity while the hook is healthy.
  -- When the process crashes / hook exits / 408 ceiling hits, the column goes
  -- stale and the reconciler takes over within 30s.
  hook_active_until     TIMESTAMPTZ,
  final_status          TEXT
    CHECK (final_status IS NULL OR final_status IN ('completed','failed','abandoned')),
  final_cost_micros     BIGINT,
  finalized_at          TIMESTAMPTZ,
  CONSTRAINT finalized_consistency
    CHECK ((final_status IS NULL AND final_cost_micros IS NULL AND finalized_at IS NULL)
        OR (final_status IS NOT NULL AND finalized_at IS NOT NULL))
);

-- Reconciler selects unresolved rows in submitted_at order with adaptive
-- cadence (TR-2 selectDueForReconciliation). Partial index keeps the hot
-- working set tight.
CREATE INDEX deep_research_submissions_unresolved
  ON deep_research_submissions (submitted_at)
  WHERE final_status IS NULL;

-- Ops index: tenant-scoped queries ("all pending submissions for tenant X")
-- during incident triage. Cheap insurance; the partial-index filter keeps it
-- proportional to in-flight count, not total rows.
CREATE INDEX deep_research_submissions_unresolved_by_tenant
  ON deep_research_submissions (tenant_id, submitted_at)
  WHERE final_status IS NULL;

-- Retention: finalized rows kept 90 days for month-end reconciliation against
-- Perplexity's invoice. sweepFinalizedSubmissions (TR-2) prunes from this index.
CREATE INDEX deep_research_submissions_finalized
  ON deep_research_submissions (finalized_at)
  WHERE final_status IS NOT NULL;

CREATE TABLE deep_research_outbox (
  outbox_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deep_research_id UUID NOT NULL,
  kind             TEXT NOT NULL
    CHECK (kind IN ('pre_charge','delta')),
  payload_json     JSONB NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error       TEXT,
  -- Idempotency: at most one pre_charge + one delta per submission. A
  -- second enqueue is silently absorbed by ON CONFLICT DO NOTHING in the
  -- enqueue path (TR-3).
  UNIQUE (deep_research_id, kind)
);

CREATE INDEX deep_research_outbox_due
  ON deep_research_outbox (next_attempt_at);
