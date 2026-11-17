-- migrations/017_refresh_openai_models_and_enable.sql
-- Refresh the OpenAI/Codex model set and enable the vendor for all environments.
--
-- Why: migration 015 seeded OpenAI disabled with a placeholder model set that
-- included gpt-5.3-codex. OpenAI has retired the 5.3 line (the Codex line moved
-- onto mainline 5.4+ versioning), so gpt-5.3-codex no longer exists upstream.
-- The Codex CLI reads its selectable-model menu from this proxy's
-- /codex/v1/models catalog, which is driven by allowed_models, so the allowlist
-- IS the menu. This migration sets the menu to the current, purchasable set and
-- enables metering.
--
-- Model set: the gpt-5.6 flagship trio (sol/terra/luna) plus the gpt-5.4 line
-- (gpt-5.4 / -mini / -nano) as cheaper options.
--
-- Rates: every value is the published OpenAI *Standard* per-1M price expressed
-- in micros-per-million (1_000_000 micros = $1), verified byte-for-byte against
-- OpenAI's pricing page. cache_write_micros = 1.25x the input rate for the
-- GPT-5.6 family (documented cache-write premium) and 0 for pre-5.6 models
-- (no cache-write fee; those models also never emit cache_write_tokens).
--
-- Caveat (documented, not a bug): gpt-5.4 / -mini / -nano publish a
-- "<272K context length" pricing tier. The rates below are that tier. The proxy
-- prices a single flat rate per model, so requests whose input exceeds 272K
-- tokens are billed at the <272K rate (a bounded under-charge). The gpt-5.6
-- trio is flat-rate with no context tier.
--
-- Idempotent upsert: converges every environment (whether the vendor row was
-- enabled by hand or left disabled as migration 015 seeded it) onto one
-- known-good state.

BEGIN;

INSERT INTO developer_proxy_vendor_config (vendor, base_url, allowed_models, pricing, enabled)
VALUES (
  'openai',
  'https://api.openai.com',
  ARRAY['gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-5.4','gpt-5.4-mini','gpt-5.4-nano'],
  '{
    "gpt-5.6-sol":   {"in_micros": 5000000, "out_micros": 30000000, "cache_read_micros": 500000, "cache_write_micros": 6250000},
    "gpt-5.6-terra": {"in_micros": 2500000, "out_micros": 15000000, "cache_read_micros": 250000, "cache_write_micros": 3125000},
    "gpt-5.6-luna":  {"in_micros": 1000000, "out_micros":  6000000, "cache_read_micros": 100000, "cache_write_micros": 1250000},
    "gpt-5.4":       {"in_micros": 2500000, "out_micros": 15000000, "cache_read_micros": 250000, "cache_write_micros": 0},
    "gpt-5.4-mini":  {"in_micros":  750000, "out_micros":  4500000, "cache_read_micros":  75000, "cache_write_micros": 0},
    "gpt-5.4-nano":  {"in_micros":  200000, "out_micros":  1250000, "cache_read_micros":  20000, "cache_write_micros": 0}
  }'::jsonb,
  TRUE
)
ON CONFLICT (vendor) DO UPDATE SET
  allowed_models = EXCLUDED.allowed_models,
  pricing        = EXCLUDED.pricing,
  enabled        = TRUE;

COMMIT;
