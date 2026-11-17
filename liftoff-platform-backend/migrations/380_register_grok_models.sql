-- Register the Grok models (served via OpenRouter) in the model registry so the
-- Workspace AI vendor selection can offer them and the model-pricing sync job
-- picks up their live rates and context windows.
--
-- Registry provider key is 'grok', NOT 'openrouter' — the same reason migration
-- 322 gave for qwen/deepseek/kimi: openrouter-tier-loader.ts selects the NEWEST
-- approved row per tier WHERE provider='openrouter', so registering these under
-- 'openrouter' would silently replace GLM as the openrouter tier map
-- platform-wide. The RUNTIME execution provider for all of these remains
-- 'openrouter' (invocations CHECK, engine resolver, 'openrouter:' pricing keys
-- are unchanged).
--
-- Kill switch (no redeploy):
--   UPDATE models SET status='disabled' WHERE provider='grok';
--
-- models.provider is a bare VARCHAR(50) with no CHECK constraint (verified
-- against 001_initial_schema.sql), so no ALTER is needed to admit a new key.
--
-- Tier assignment, and why it is not the vendor's own ordering:
--   flagship  x-ai/grok-4.6   500k window, the newest and most capable
--   medium    x-ai/grok-4.3   1M window, materially cheaper than 4.6
--   small     x-ai/grok-4.20  2M window, the SPEED-optimised model
--
-- The small tier is not cheaper than medium here — 4.20 and 4.3 are listed at
-- the same rate. Small buys latency and window, not savings. That is a
-- deliberate product decision; do not "fix" it by duplicating medium down.
--
-- Two current Grok models are deliberately NOT registered:
--   x-ai/grok-4.20-multi-agent  supports neither `tools` nor `tool_choice`, so
--                               it breaks tool dispatch AND the forced-tool
--                               responseSchema path used by 12+ call sites.
--   ~x-ai/grok-latest           a moving alias; pinning it would desync the
--                               pricing sync, the context-window sync and the
--                               branding map on every xAI release.
--
-- context_window is left NULL here rather than hardcoded: the model-pricing-sync
-- job records it from the live endpoints API, and that job also reports any
-- approved model still missing one, so a NULL is visible rather than silent.
INSERT INTO models (name, provider, model_id, tier, capabilities, status) VALUES
  ('Grok 4.6',   'grok', 'x-ai/grok-4.6',   'flagship', '["tools","streaming"]', 'approved'),
  ('Grok 4.3',   'grok', 'x-ai/grok-4.3',   'medium',   '["tools","streaming"]', 'approved'),
  ('Grok 4.20',  'grok', 'x-ai/grok-4.20',  'small',    '["tools","streaming"]', 'approved')
ON CONFLICT DO NOTHING;
