-- 361: reflection_suggestions — undo, concurrency, and closure.
--
-- skill-provenance.ts protects `learned` / `operator` / archived skills from a
-- redistill and refuses provenance downgrades. It does not protect against four
-- other things, and these columns are what each of them needs:
--
--   NO UNDO. There is no "revert refinement N". A suggestion is applied and the
--   previous state is gone, so a refinement that made an agent worse can only be
--   corrected by writing a new one on top and hoping.
--     → before_state, after_state
--
--   LOST UPDATES. The reflection LLM call takes seconds. An operator edit
--   landing inside that window is silently overwritten by a plan built against
--   the pre-edit state — the operator's change simply disappears, with nothing
--   recording that it was ever made.
--     → baseline_hash, captured BEFORE the LLM call and re-checked at apply time
--
--   STALE PLANS. A suggestion planned against a trajectory that has since moved
--   is applied anyway, so an agent is corrected for behaviour it has already
--   stopped exhibiting.
--     → trajectory_version
--
--   NO CLOSURE. Nothing checks whether a promoted memory or refined skill helped.
--   Only agent_skills.usefulness_score closes any loop at all, and only on the
--   autonomous surface. A refinement that changed nothing is invisible.
--     → expected_outcome, paired with the effective_measure / feedback columns
--       migration 063 already added for exactly this purpose, written by
--       recordSuggestionOutcome. This migration adds ONE genuinely new outcome
--       field and wires the rest, rather than building the mechanism a second
--       time.

ALTER TABLE reflection_suggestions
  ADD COLUMN IF NOT EXISTS before_state       jsonb,
  ADD COLUMN IF NOT EXISTS after_state        jsonb,
  ADD COLUMN IF NOT EXISTS expected_outcome   text,
  ADD COLUMN IF NOT EXISTS baseline_hash      text,
  ADD COLUMN IF NOT EXISTS trajectory_version integer;

COMMENT ON COLUMN reflection_suggestions.before_state IS
  'Snapshot of the entity this suggestion targets, taken BEFORE the reflection LLM call. Two jobs: it is what an operator revert writes back, and it is what baseline_hash is computed over. NULL on suggestions created before this migration, which therefore cannot be reverted — recorded honestly rather than reconstructed.';
COMMENT ON COLUMN reflection_suggestions.after_state IS
  'Snapshot of the entity immediately after the suggestion was applied. Paired with before_state so a revert can be verified rather than assumed: if the current state does not match after_state, something else has changed the entity since and a blind revert would discard that too.';
COMMENT ON COLUMN reflection_suggestions.expected_outcome IS
  'What the reflection expected to improve, and how to tell. The only genuinely new outcome field — the OBSERVED side reuses effective_measure and feedback (migration 063), written by recordSuggestionOutcome. Without a stated expectation, "did this help?" has no answer to compare against.';
COMMENT ON COLUMN reflection_suggestions.baseline_hash IS
  'sha256 of before_state at PLAN time. Re-checked at apply time: a mismatch means the entity changed while the reflection was being planned — an operator edit landing inside the LLM call''s window — and the apply is REFUSED rather than clobbering it. The suggestion is kept and logged, not discarded.';
COMMENT ON COLUMN reflection_suggestions.trajectory_version IS
  'The agent''s invocation count when this suggestion was planned. A suggestion whose version is stale on arrival was planned against behaviour the agent has since moved past, and is discarded rather than applied to an agent it no longer describes.';
