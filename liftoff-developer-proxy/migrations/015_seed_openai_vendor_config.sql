-- migrations/015_seed_openai_vendor_config.sql
-- Seed the OpenAI vendor config (same shape as the Anthropic seed in
-- migration 004): base URL, allowed models, and a pricing blob keyed by
-- canonical model with micros-per-million rates. Rates sourced from OpenAI's
-- published API pricing. Seeded disabled — flip `enabled` to true per
-- environment when the model set and rates are confirmed.

BEGIN;

INSERT INTO developer_proxy_vendor_config (vendor, base_url, allowed_models, pricing, enabled)
VALUES (
  'openai',
  'https://api.openai.com',
  ARRAY['gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-5.3-codex'],
  '{
    "gpt-5.6-sol":   {"in_micros": 5000000, "out_micros": 30000000, "cache_read_micros": 500000, "cache_write_micros": 6250000},
    "gpt-5.6-terra": {"in_micros": 2500000, "out_micros": 15000000, "cache_read_micros": 250000, "cache_write_micros": 3125000},
    "gpt-5.6-luna":  {"in_micros": 1000000, "out_micros":  6000000, "cache_read_micros": 100000, "cache_write_micros": 1250000},
    "gpt-5.3-codex": {"in_micros": 1750000, "out_micros": 14000000, "cache_read_micros": 175000, "cache_write_micros":       0}
  }'::jsonb,
  FALSE
)
ON CONFLICT (vendor) DO NOTHING;

COMMIT;
