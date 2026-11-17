-- Register the Qwen / DeepSeek / Kimi models (all served via OpenRouter) in the
-- model registry so the Workspace AI vendor selection can offer them and the
-- model-pricing sync job picks up their live rates.
--
-- Registry provider keys are DISTINCT per vendor ('qwen' / 'deepseek' / 'kimi'),
-- NOT 'openrouter': openrouter-tier-loader.ts selects the NEWEST approved row
-- per tier WHERE provider='openrouter', so registering these under 'openrouter'
-- would silently replace GLM as the openrouter tier map platform-wide. The
-- RUNTIME execution provider for all of these remains 'openrouter' (invocations
-- CHECK, engine resolver, 'openrouter:' pricing keys are unchanged).
--
-- Kill switch per vendor (no redeploy):
--   UPDATE models SET status='disabled' WHERE provider='qwen';      -- or 'deepseek' / 'kimi'
--
-- DeepSeek has no third current model below v4-flash (V3.2 is older AND
-- pricier) and Moonshot has no small model, so those vendors register only
-- flagship + medium rows; the Workspace AI vendor map duplicates medium into
-- the small tier for them (user decision).
INSERT INTO models (name, provider, model_id, tier, capabilities, status) VALUES
  ('Qwen 3.8 Max',      'qwen',     'qwen/qwen3.8-max',            'flagship', '["tools","streaming"]', 'approved'),
  ('Qwen 3.7 Plus',     'qwen',     'qwen/qwen3.7-plus',           'medium',   '["tools","streaming"]', 'approved'),
  ('Qwen 3.7 Flash',    'qwen',     'qwen/qwen3.7-flash',          'small',    '["tools","streaming"]', 'approved'),
  ('DeepSeek V4 Pro',   'deepseek', 'deepseek/deepseek-v4-pro',    'flagship', '["tools","streaming"]', 'approved'),
  ('DeepSeek V4 Flash', 'deepseek', 'deepseek/deepseek-v4-flash',  'medium',   '["tools","streaming"]', 'approved'),
  ('Kimi K3',           'kimi',     'moonshotai/kimi-k3',          'flagship', '["tools","streaming"]', 'approved'),
  ('Kimi K2.6',         'kimi',     'moonshotai/kimi-k2.6',        'medium',   '["tools","streaming"]', 'approved')
ON CONFLICT DO NOTHING;
