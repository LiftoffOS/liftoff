-- 236_deep_research_submissions_multi_vendor.sql
-- Extend the deep_research durability stack to cover OpenAI o3-deep-research
-- and Google Gemini Deep Research (standard + Max). The 233 migration scoped
-- the registry + reconciler to Perplexity; this migration generalizes it.
--
-- Renumbered from 234 → 236. A database that applied 235 before 234 trips
-- pg-migrate's strict order check, which refuses to run 234; renumbering past
-- 235 puts this back in linear order. The DDL is guarded with IF-NOT-EXISTS
-- checks so a database that already has the column + index from 234 re-runs
-- as a no-op.
--
-- Reasoning:
--   - The hook fast path (event-publisher + outbox) is already vendor-agnostic
--     (works for any WebToolSpendEvent).
--   - The recovery path (registry + reconciler) was Perplexity-only by
--     construction: insertSubmission was only wired into perplexity-client,
--     and the reconciler only knew how to poll /async/chat/completions.
--   - Without this migration, OpenAI/Google calls have no crash-recovery and
--     no 408-ceiling recovery: a process crash mid-call → lost billing event.
--
-- Changes:
--   1. New `vendor` column: source of truth for the reconciler to pick the
--      correct poll endpoint + cost extractor. Default 'perplexity' for the
--      handful of pre-migration rows (the default keeps the DDL safe under
--      any timing).
--   2. The reasoning_effort CHECK retains the {low,medium,high} set. All
--      three vendors normalize to one of these before insert:
--        - Perplexity coerces 'highest' → 'high' in deepResearch()
--        - OpenAI always records 'high' (D6 — max_tool_calls fixed at 100)
--        - Google records 'medium' for standard variant, 'high' for max
--      So 'highest' never lands in this column.
--
-- No explicit BEGIN/COMMIT — the migration runner wraps each file in its
-- own transaction (verified: migrations 220/221/231/232/233 use the same
-- bare-statement style).

ALTER TABLE deep_research_submissions
  ADD COLUMN IF NOT EXISTS vendor TEXT NOT NULL DEFAULT 'perplexity'
    CHECK (vendor IN ('perplexity', 'openai', 'google'));

-- Index the unresolved partition by vendor too. The reconciler doesn't
-- filter by vendor (it iterates all unresolved rows and dispatches per-row),
-- but ops triage queries ("how many OpenAI submissions are pending?") are
-- common enough to warrant the cover.
CREATE INDEX IF NOT EXISTS deep_research_submissions_unresolved_by_vendor
  ON deep_research_submissions (vendor, submitted_at)
  WHERE final_status IS NULL;
