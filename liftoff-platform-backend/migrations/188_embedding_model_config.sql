-- Migration 188: Add embedding model configuration to routing policies
--
-- Migration 187 set up tier-based LLM routing but omitted the 'embedding'
-- task type. Embedding models are a different concept — no tier, one model
-- per provider. The platform runs on GCP so Google Vertex AI text-embedding-004
-- is the correct provider/model.
--
-- Adds providerOverrides.embedding = 'google' and
-- taskOverrides.embedding = 'text-embedding-004' to all model_configs.
-- tenant-runtime embedding.ts reads these to route embedding calls to
-- Vertex AI instead of falling back to the default LLM provider (anthropic).

BEGIN;

UPDATE model_configs
SET routing_policy = routing_policy
  || '{"providerOverrides": {"embedding": "google"}}'::jsonb
  || jsonb_build_object(
       'taskOverrides',
       (routing_policy->'taskOverrides') || '{"embedding": "text-embedding-004"}'::jsonb
     ),
  updated_at = NOW();

COMMIT;
