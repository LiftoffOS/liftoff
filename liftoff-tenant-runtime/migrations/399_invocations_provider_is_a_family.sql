-- 399: a provider names a model FAMILY, so the constraint admits the families.
--
-- GLM, Qwen, DeepSeek and Kimi are four vendors reached through one gateway,
-- and all four resolved as 'openrouter'. Resolution produces one adapter and
-- one tier map per provider, so that value could not say which family a run had
-- chosen: it answered all four with the single OpenRouter tier map, which
-- publishes GLM. A workspace set to Qwen ran GLM.
--
-- Migration 398 admitted the three that had already become providers; this adds
-- the fourth, GLM, which is the one that was still spelled as the gateway. The
-- constraint has now been widened once per provider added (310 for 'openrouter',
-- 391 for 'xai', 398 for three at once), which is why
-- scripts/__tests__/invocations-provider-constraint.test.ts compares it against
-- RESOLVED_PROVIDERS rather than anyone remembering.
--
-- 'openrouter' STAYS ADMITTED, and is the one value here that is not a family.
-- Rows already written recorded it, and an invocations row is a record of what
-- ran — history is not rewritten to match a vocabulary it predates. It is
-- carried in the test's HISTORICAL_ONLY list rather than silently tolerated, so
-- nothing can resolve it again without that list being changed on purpose.

ALTER TABLE invocations DROP CONSTRAINT IF EXISTS chk_invocations_provider;
ALTER TABLE invocations ADD CONSTRAINT chk_invocations_provider
  CHECK (provider IN (
    'anthropic', 'anthropic-vertex', 'google', 'openai', 'xai',
    'glm', 'qwen', 'deepseek', 'kimi',
    -- Historical only. Nothing resolves to it; rows written before the split
    -- carry it.
    'openrouter'
  ));

COMMENT ON COLUMN invocations.provider IS
  'Model family this invocation ran on (anthropic, anthropic-vertex, google, openai, xai, glm, qwen, deepseek, kimi). '
  'openrouter is historical: it named the gateway the four open-weight families are reached through, not a family.';

-- ── Stored agent configuration ──────────────────────────────────────────────
-- `agents.model_config` is a verbatim copy of the control plane's payload, and
-- the runtime resolves its adapter and tier map from `provider`. A row still
-- saying 'openrouter' resolves to no tier map at all.
--
-- The runtime translates one at read time as well (provider-resolution.ts), and
-- both are needed for different reasons: the read-time translation covers a row
-- that arrives AFTER this runs — a resumed context, a replayed event, a control
-- plane not yet on its own migration 448 — while this one gives the stored data
-- a defined end, so the translation is a compatibility path rather than the
-- permanent way this field is understood.
--
-- The family comes from the MODEL ID, which is the only thing in these rows
-- that distinguishes the four. Same derivation as the code, same GLM fallback
-- and for the same reason: GLM is what the gateway name resolved to, so
-- anything else would change which model an existing agent runs.
--
-- `cached_model_configs.routing_policy` is the tenant's workspace policy, cached
-- from the control plane and refreshed from it, so it is NOT rewritten here —
-- migration 448 moves the source and the cache follows. Rewriting a cache
-- in place is how a cache and its source start disagreeing.

UPDATE agents
   SET model_config = jsonb_set(model_config, '{provider}',
         CASE
           WHEN model_config->>'modelId' LIKE 'qwen/%'       THEN '"qwen"'::jsonb
           WHEN model_config->>'modelId' LIKE 'deepseek/%'   THEN '"deepseek"'::jsonb
           WHEN model_config->>'modelId' LIKE 'moonshotai/%' THEN '"kimi"'::jsonb
           -- Grok left the gateway for its own API; a Grok id under the gateway
           -- name is not one of the open-weight families.
           WHEN model_config->>'modelId' ~* '^(x-ai/)?grok[-.]' THEN '"xai"'::jsonb
           ELSE '"glm"'::jsonb
         END),
       updated_at = NOW()
 WHERE model_config->>'provider' = 'openrouter';
