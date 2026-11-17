-- Migration 552: Qwen's small tier moves to 3.8 Flash.
--
-- `qwen/qwen3.7-flash` is superseded by `qwen/qwen3.8-flash` — same 1,000,000
-- window, same text/image/video input, current generation.
--
-- MEDIUM IS DELIBERATELY UNTOUCHED and stays on `qwen/qwen3.7-plus`. Qwen
-- publishes no 3.8 Plus: the 3.8 line is max-0902, 2.4t-a95b, 27b, flash and
-- omni-flash. None of those is the Plus class — `qwen3.8-27b` is a dense 27B
-- vision-language model, a step DOWN in size rather than a successor, and
-- `qwen3.8-2.4t-a95b` is the open-weight variant of Max at Max's own price.
-- So the ladder straddles two generations on purpose, until Qwen ships one.
--
-- THE RATE COMPARISON THAT MATTERS IS NOT THE HEADLINE. 3.8 Flash lists at
-- 0.15/0.47 against 3.7 Flash's 0.03/0.13, which reads as five times dearer and
-- is not. 3.7 Flash carries CONDITIONAL BANDS (migration 379's subject, and the
-- reason pricing-tiers.ts exists): from 32,000 prompt tokens it bills 0.10/0.40
-- and from 256,000 it bills 0.20/0.80. 32,000 is a routine turn once skills and
-- tool results are injected — the pricing table says exactly that about this
-- model — so on real traffic the move is about 1.5x on input, and CHEAPER above
-- 256,000. 3.8 Flash is flat, which also retires a band this estate
-- under-attributed for months before the evaluator existed.
--
-- `qwen3.7-flash` keeps its approved row, its tier and its banded rate: it is
-- simply no longer the newest `small` for this provider, and every historic
-- llm_usage_log row naming it must still price at the bands it actually ran at.
--
-- CONTEXT WINDOW recorded at 1,000,000, the max across serving endpoints, which
-- is what the pricing sync's fetchContextWindow records — a different figure
-- here would be overwritten on the next run while disagreeing with it until
-- then.
--
-- `models` is a GLOBAL non-RLS catalog: plain upsert, no tenant scope.
-- Idempotent via ON CONFLICT (model_id).

BEGIN;

INSERT INTO models (name, provider, model_id, tier, status, capabilities)
VALUES
  ('Qwen 3.8 Flash', 'qwen', 'qwen/qwen3.8-flash', 'small', 'approved',
   '["text-generation", "function-calling", "reasoning", "vision"]'::jsonb)
ON CONFLICT (model_id) DO UPDATE SET
  tier       = EXCLUDED.tier,
  status     = EXCLUDED.status,
  updated_at = NOW();

UPDATE models SET context_window = 1000000, updated_at = NOW()
 WHERE model_id = 'qwen/qwen3.8-flash' AND context_window IS NULL;

COMMIT;
