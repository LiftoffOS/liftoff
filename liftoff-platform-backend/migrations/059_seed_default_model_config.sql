-- Migration 059: Seed default model and model config for all tenants
-- Every tenant needs a model config with a routing policy so agents can execute

BEGIN;

-- Register the default model (gpt-5.4 via OpenAI)
INSERT INTO models (id, name, provider, model_id, status, capabilities)
VALUES (
  'a1b2c3d4-0000-0000-0000-000000000001',
  'GPT-5.4',
  'openai',
  'gpt-5.4',
  'approved',
  '["text-generation", "function-calling", "reasoning"]'::jsonb
) ON CONFLICT (id) DO NOTHING;

-- Create model config for each tenant that doesn't have one
INSERT INTO model_configs (tenant_id, model_id, version, routing_policy)
SELECT t.id, 'a1b2c3d4-0000-0000-0000-000000000001', 1,
  '{"defaultModel": "gpt-5.4", "taskOverrides": {}}'::jsonb
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM model_configs mc WHERE mc.tenant_id = t.id
);

COMMIT;
