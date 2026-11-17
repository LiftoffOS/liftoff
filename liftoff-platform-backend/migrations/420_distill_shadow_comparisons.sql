-- Shadow-mode comparisons: the waved strategy run alongside a real distillation.
--
-- WHY A SHADOW AND NOT JUST THE HARNESS.
--
-- The A/B harness replays a fixed corpus, which makes its two arms perfectly
-- comparable to each other and not comparable to real usage at all: a set of
-- curated templates against a test tenant is a different population from what
-- customers actually type against their own connectors. Comparing the harness's
-- waved numbers with real single-strategy numbers would measure the corpus.
--
-- Shadow mode closes that. Every real distillation optionally gets a second,
-- discarded run of the waved strategy over the SAME input, in the SAME tenant,
-- against the SAME catalog. One row here pairs the two.
--
-- WHAT IT COSTS AND WHAT IT CANNOT DO.
--
-- It roughly doubles distillation spend while enabled. The shadow runs AFTER
-- the real distillation has returned, never alongside it, so it adds nothing to
-- the person's wait and never contends with the real call for a rate limit. Its
-- output is discarded: no artifact handle is minted for it and no agent is ever
-- created from it.
--
-- WHY BOTH ARTIFACTS ARE STORED.
--
-- The structural metrics below can be computed at shadow time, but the plan's
-- pairwise judge cannot: it needs both texts, and it is run later in a batch so
-- a slow judge cannot distort the latency it would otherwise share a rate limit
-- with. Storing them is the only way to defer that. They expire — this is
-- experiment data, not a record of anything — and the table is RLS-forced like
-- every other table holding a tenant's generated agent.

CREATE TABLE IF NOT EXISTS distill_shadow_comparisons (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  tenant_id                   UUID NOT NULL,
  -- Set when the real distillation was a redistill. distill_update is a large
  -- share of volume and the flow the split is expected to help least, so
  -- being able to slice on it is the point rather than a nicety.
  agent_id                    UUID,
  purpose                     VARCHAR(32) NOT NULL,

  -- The two runs in distill_runs this row compares.
  real_run_id                 UUID NOT NULL,
  shadow_run_id               UUID NOT NULL,

  -- End to end, client-side, for each arm. The shadow's time-to-summary is the
  -- number the whole split exists to move; the real arm has no equivalent,
  -- because a single call has nothing to report until it is finished.
  real_duration_ms            INTEGER,
  shadow_duration_ms          INTEGER,
  shadow_time_to_summary_ms   INTEGER,

  -- Structural quality, computed at shadow time from the two artifacts.
  --
  -- graph_decision_agrees is the headline: the whole prompt is built around the
  -- STEP 1 emit-or-omit decision, so the arms disagreeing about it is a
  -- different agent, not a differently-worded one.
  graph_decision_agrees       BOOLEAN,
  trigger_type_agrees         BOOLEAN,
  -- The regression the v5 and v7 prompt rewrites were both about: skills that
  -- restate the steps instead of complementing them. Recorded for BOTH arms,
  -- because the number is only meaningful as a difference — the single arm is
  -- not at zero either.
  real_skills_restate_rate    NUMERIC(5,4),
  shadow_skills_restate_rate  NUMERIC(5,4),
  -- instructionsMd repeating identity text it is told to assume. The single arm
  -- can see what it wrote; the split arm is working from a seed, so this is the
  -- check that the seed does its job.
  real_identity_leakage       NUMERIC(5,4),
  shadow_identity_leakage     NUMERIC(5,4),

  -- Kept for the deferred pairwise judge. Expire with the row.
  real_output                 JSONB,
  shadow_output               JSONB,

  -- Set once the judge has read this row, so a re-run does not re-judge and
  -- re-bill work already done.
  judged_at                   TIMESTAMPTZ,
  -- 'single' | 'waved' | 'tie', un-blinded.
  judge_winner                VARCHAR(16),
  judge_reasoning             TEXT,
  -- Which arm the judge was shown first. Across enough rows this should be near
  -- even; a lopsided split means the blinding is broken and every verdict in
  -- the table is suspect.
  judge_shown_shadow_first    BOOLEAN,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at                  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS distill_shadow_tenant_created_idx
  ON distill_shadow_comparisons (tenant_id, created_at DESC);

-- The judge sweeps for unjudged rows.
CREATE INDEX IF NOT EXISTS distill_shadow_unjudged_idx
  ON distill_shadow_comparisons (created_at)
  WHERE judged_at IS NULL;

CREATE INDEX IF NOT EXISTS distill_shadow_expires_idx
  ON distill_shadow_comparisons (expires_at);

COMMENT ON TABLE distill_shadow_comparisons IS
  'Pairs a real single-strategy distillation with a discarded waved shadow run over the same input, for the real-traffic half of the single-vs-waved comparison.';

-- RLS (INV-PB-001). Holds a tenant's generated agent in both columns, which is
-- exactly the material distill_artifacts is FORCE-RLS'd for. The judge and the
-- aggregation are cross-tenant operator reads and go through withAdminScope /
-- the psql job, both BYPASSRLS.
ALTER TABLE distill_shadow_comparisons ENABLE ROW LEVEL SECURITY;
ALTER TABLE distill_shadow_comparisons FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON distill_shadow_comparisons
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
