-- Per-candidate dedup decisions made when reflection produces a newPitfallSkill.
-- One row per (task, candidate). Records cosine similarity, the matched
-- existing skill (if any), the decision, and the reflection-originating
-- skill_id. Counts and analytics are derivable on read via GROUP BY — no
-- rollup columns.
CREATE TABLE skill_dedup_events (
  id                    BIGSERIAL PRIMARY KEY,
  agent_id              UUID NOT NULL REFERENCES internal_agents(id) ON DELETE CASCADE,
  tenant_id             UUID NOT NULL,
  task_id               TEXT,
  candidate_name        TEXT NOT NULL,
  candidate_role_wide   BOOLEAN NOT NULL DEFAULT false,
  originating_skill_id  TEXT,
  decision              TEXT NOT NULL
                          CHECK (decision IN ('appended', 'refused', 'merged')),
  matched_skill_id      TEXT,
  similarity_score      DOUBLE PRECISION,
  decided_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_skill_dedup_events_agent
  ON skill_dedup_events(agent_id, decided_at DESC);

CREATE INDEX idx_skill_dedup_events_matched
  ON skill_dedup_events(agent_id, matched_skill_id)
  WHERE matched_skill_id IS NOT NULL;
