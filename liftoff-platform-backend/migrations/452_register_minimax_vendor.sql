-- Register MiniMax as a Workspace AI vendor.
--
-- Two models, not three, and the small tier duplicating medium is the answer
-- rather than a gap. M3 is ~428B total / ~23B activated at a 1M window and is
-- the only MiniMax model that accepts an image or a video; the whole M2.x line
-- (M2, M2.1, M2.5, M2.7) is one ~229B / 10B-activated model revised four times
-- at a 204,800 window. So an older M2 revision is cheaper without being
-- smaller or faster, which is not what a speed tier is for. Same shape as
-- DeepSeek and Moonshot: no small row, and the vendor map's seed duplicates
-- medium into small.
--
-- Verified against OpenRouter's live catalog and endpoints API: both ids are served, both support tools and tool_choice, and
-- neither publishes a conditional pricing band.
--
-- 'vision' and 'video' on M3 come from the vendor, not from assumption — the
-- catalog reports `input_modalities: [text, image, video]`. src/llm/vision.ts
-- reads those marks, so without them a customer who attaches a screenshot is
-- told the model cannot look at one. M2.7 is text-only and is marked as such
-- by omission.
--
-- context_window is left NULL per migration 343: the pricing sync reads it from
-- the endpoints API on its next run, and a window hardcoded here would be a
-- second source of truth for a number the vendor already answers.
--
-- No explicit created_at, unlike migration 451. That one needed it because two
-- DeepSeek rows share tier='medium' and the tier loader breaks the tie on
-- created_at. MiniMax has no prior rows and one row per tier, so there is no
-- tie to break.
--
-- Idempotent: `models.model_id` is unique (models_model_id_key, migration 187),
-- and the CHECK rebuild below reads its constraint names from the catalog.
--
-- Kill switch, no redeploy:
--   UPDATE models SET status='disabled' WHERE provider='minimax';
--
-- `models` is not RLS, and neither internal_agents nor internal_agent_versions
-- is written here — only their constraints are replaced — so no FORCE dance.

BEGIN;

INSERT INTO models (name, provider, model_id, tier, capabilities, status) VALUES
  ('MiniMax M3',   'minimax', 'minimax/minimax-m3',   'flagship',
   '["tools","streaming","vision","video"]'::jsonb, 'approved'),
  ('MiniMax M2.7', 'minimax', 'minimax/minimax-m2.7', 'medium',
   '["tools","streaming"]'::jsonb, 'approved')
ON CONFLICT (model_id) DO NOTHING;

-- Admit 'minimax' to the per-AI-team vendor override.
--
-- Migration 328 wrote the CHECK as an inline list and 381 extended it for Grok;
-- a tenth vendor means dropping and re-adding on BOTH tables. The versions half
-- is not optional: the override rides the same PUT as role/responsibilities/
-- skills, so a value that passes on the live row and fails on its version
-- snapshot fails the WHOLE save. 179 had to repair exactly that.
--
-- Constraint names are read from the catalog rather than assumed, for 381's
-- reason: 328 declared the CHECK inline with no name, the generated form is
-- predictable but not guaranteed, and a wrong DROP name aborts the whole
-- pending batch and blocks every deploy queued behind it.
--
-- VARCHAR(20) already accommodates 'minimax' (7 chars), so no type change.
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT rel.relname AS table_name, con.conname AS constraint_name
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE con.contype = 'c'
       AND rel.relname IN ('internal_agents', 'internal_agent_versions')
       AND pg_get_constraintdef(con.oid) ILIKE '%ai_vendor_override%'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', c.table_name, c.constraint_name);
  END LOOP;
END $$;

ALTER TABLE internal_agents
  ADD CONSTRAINT internal_agents_ai_vendor_override_check
    CHECK (ai_vendor_override IN (
      'default', 'anthropic', 'openai', 'google', 'deepseek', 'glm', 'kimi',
      'minimax', 'qwen', 'grok'
    ));

ALTER TABLE internal_agent_versions
  ADD CONSTRAINT internal_agent_versions_ai_vendor_override_check
    CHECK (ai_vendor_override IN (
      'default', 'anthropic', 'openai', 'google', 'deepseek', 'glm', 'kimi',
      'minimax', 'qwen', 'grok'
    ));

COMMIT;
