-- Register GLM (Z.ai) models in the model registry so tenants can select them.
-- provider='openrouter' matches the LLMProvider / ResolvedProvider 'openrouter' member and the
-- 'openrouter:' pricing keys in src/llm/pricing.ts. Kill switch:
--   UPDATE models SET status='disabled' WHERE provider='openrouter';   (no redeploy)
--
-- Verify first: is there a CHECK/enum on models.provider? If so, ALTER it to allow 'openrouter'.
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'models'::regclass AND contype = 'c';
INSERT INTO models (name, provider, model_id, tier, capabilities, status) VALUES
  ('GLM 5.2',        'openrouter', 'z-ai/glm-5.2',        'flagship', '["tools","streaming"]', 'approved'),
  ('GLM 5 Turbo',    'openrouter', 'z-ai/glm-5-turbo',    'medium',   '["tools","streaming"]', 'approved'),
  ('GLM 4.7 Flash',  'openrouter', 'z-ai/glm-4.7-flash',  'small',    '["tools","streaming"]', 'approved')
ON CONFLICT DO NOTHING;
