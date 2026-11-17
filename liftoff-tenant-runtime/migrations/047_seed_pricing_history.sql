-- Seed model_pricing_history with current rates from pricing.ts
-- effective_from is set to epoch so all historical invocations can be matched.

INSERT INTO model_pricing_history (provider, model_id, input_price_per_million, output_price_per_million, cached_input_price_per_million, effective_from)
VALUES
  -- Anthropic direct API
  ('anthropic', 'claude-opus-4.6',   5.00,  25.00, 0.50, '2025-01-01'),
  ('anthropic', 'claude-opus-4.5',   5.00,  25.00, 0.50, '2025-01-01'),
  ('anthropic', 'claude-opus-4.1',   15.00, 75.00, 1.50, '2025-01-01'),
  ('anthropic', 'claude-opus-4',     15.00, 75.00, 1.50, '2025-01-01'),
  ('anthropic', 'claude-sonnet-4.6', 3.00,  15.00, 0.30, '2025-01-01'),
  ('anthropic', 'claude-sonnet-4.5', 3.00,  15.00, 0.30, '2025-01-01'),
  ('anthropic', 'claude-sonnet-4',   3.00,  15.00, 0.30, '2025-01-01'),
  ('anthropic', 'claude-haiku-4.5',  1.00,  5.00,  0.10, '2025-01-01'),
  ('anthropic', 'claude-haiku-3.5',  0.80,  4.00,  0.08, '2025-01-01'),

  -- Claude on Vertex AI
  ('vertex-ai', 'claude-opus-4.6',   5.00,  25.00, 0.50, '2025-01-01'),
  ('vertex-ai', 'claude-opus-4.5',   5.00,  25.00, 0.50, '2025-01-01'),
  ('vertex-ai', 'claude-opus-4.1',   15.00, 75.00, 1.50, '2025-01-01'),
  ('vertex-ai', 'claude-opus-4',     15.00, 75.00, 1.50, '2025-01-01'),
  ('vertex-ai', 'claude-sonnet-4.6', 3.00,  15.00, 0.30, '2025-01-01'),
  ('vertex-ai', 'claude-sonnet-4.5', 3.00,  15.00, 0.30, '2025-01-01'),
  ('vertex-ai', 'claude-sonnet-4',   3.00,  15.00, 0.30, '2025-01-01'),
  ('vertex-ai', 'claude-haiku-4.5',  1.00,  5.00,  0.10, '2025-01-01'),

  -- Gemini on Vertex AI
  ('google', 'gemini-2.5-pro',   1.25, 10.00, 0.13, '2025-01-01'),
  ('google', 'gemini-2.5-flash', 0.30, 2.50,  0.03, '2025-01-01'),
  ('google', 'gemini-2.0-flash', 0.15, 0.60,  NULL, '2025-01-01'),

  -- OpenAI
  ('openai', 'gpt-5.4',      2.50, 15.00, 0.25,  '2025-01-01'),
  ('openai', 'gpt-5.4-mini', 0.75, 4.50,  0.075, '2025-01-01'),
  ('openai', 'gpt-5.4-nano', 0.20, 1.25,  0.02,  '2025-01-01');
