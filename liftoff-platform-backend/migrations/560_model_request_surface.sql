-- Migration 560: the per-model REQUEST SURFACE becomes a registry fact
--
-- What a model will ACCEPT — a temperature, a forced `tool_choice`, structured
-- outputs, an effort level, a thinking mode — lived in a TypeScript constant, and
-- in two of them: `src/llm/providers/anthropic-shared.ts` here and
-- `src/llm/providers/anthropic-model-surface.ts` in the tenant runtime, whose own
-- header admits the copy is unguarded. Every other model fact already travels as
-- data on a 60-second overlay: the rate (migration 285), the context window
-- (343), the tier. This was the last one that needed a release in two repos.
--
-- It is also the fact with the least tolerance for being stale, and the reason is
-- asymmetric. A wrong rate misprices a row that still ran. A wrong surface is a
-- 400 on the FIRST call: `tool_choice: any` after a vendor removes forced tool
-- use, `output_config` on a model that never took it, `thinking.disabled` on
-- Sonnet 5.5. Those are the three that have actually happened here.
--
-- SHAPE: a jsonb object holding only the keys that DIFFER from the conservative
-- default, exactly as the code tables do — `{"acceptsForcedToolChoice": true}`,
-- not a full record. The semantics are unchanged and are the whole safety
-- property: an absent key means DO NOT SEND, so a model with no row at all, or a
-- row that omits a key, still gets the narrow surface. A registry row can only
-- ever GRANT a capability, never silently assume one.
--
-- SEEDED FROM THE CODE, VERBATIM. The values below are what
-- `LEGACY_SURFACES` says on the commit this migration lands with, so nothing
-- resolves differently on day one — the same property the allow-list inversion
-- was landed under, and the reason `model-surface.test.ts` freezes the resolved
-- surface per id. The code table stays as the bootstrap: what answers before the
-- first overlay load and if a load fails.
--
-- `WHERE request_surface IS NULL` on every seed, so re-running this never
-- overwrites an operator's correction with a historical one — the discipline
-- migrations 343 and 520 set for context windows.
--
-- `models` is a GLOBAL non-RLS catalog -> plain DDL and plain updates.

BEGIN;

ALTER TABLE models ADD COLUMN IF NOT EXISTS request_surface jsonb;

COMMENT ON COLUMN models.request_surface IS
  'What this model accepts, as keys that differ from the conservative default: '
  'acceptsTemperature, acceptsForcedToolChoice, acceptsStructuredOutputs, effort, '
  'thinking. An absent key means do not send it. Read as an overlay on the '
  'provider surface tables in both planes.';

-- Anthropic. Every id the estate can currently reach, including the dated
-- snapshots, so a stored pin resolves the same surface as its dateless alias.
UPDATE models SET request_surface = '{"effort": "high", "acceptsStructuredOutputs": true}'::jsonb
 WHERE provider = 'anthropic' AND model_id = 'claude-opus-5-5' AND request_surface IS NULL;

UPDATE models SET request_surface = '{"acceptsForcedToolChoice": true, "acceptsStructuredOutputs": true}'::jsonb
 WHERE provider = 'anthropic' AND model_id IN ('claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5')
   AND request_surface IS NULL;

UPDATE models SET request_surface = '{"acceptsTemperature": true, "acceptsForcedToolChoice": true, "acceptsStructuredOutputs": true}'::jsonb
 WHERE provider = 'anthropic'
   AND model_id IN ('claude-opus-4-6', 'claude-opus-4-5-20251101', 'claude-sonnet-4-6',
                    'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001')
   AND request_surface IS NULL;

UPDATE models SET request_surface = '{"acceptsTemperature": true, "acceptsForcedToolChoice": true}'::jsonb
 WHERE provider = 'anthropic'
   AND model_id IN ('claude-opus-4-5', 'claude-opus-4', 'claude-sonnet-4-5', 'claude-sonnet-4', 'claude-haiku-4-5')
   AND request_surface IS NULL;

-- Sonnet 5.5 is the one row whose surface is not a subset of an older model's.
-- It takes no temperature and no forced tool choice, it opts into structured
-- outputs because that is what replaces the forced tool, and it asks for
-- `between_tools` — the setting that returns the prose a model writes between
-- tool calls as readable text instead of an empty thinking block. Without that
-- last key a streaming assistant on this model goes silent mid-turn with no
-- error, which is a product regression a rate table could never express.
UPDATE models SET request_surface = '{"acceptsStructuredOutputs": true, "thinking": "between_tools"}'::jsonb
 WHERE provider = 'anthropic' AND model_id = 'claude-sonnet-5-5' AND request_surface IS NULL;

COMMIT;
