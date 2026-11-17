-- migrations/018_openai_full_codex_family.sql
-- Correct the OpenAI/Codex model menu.
--
-- Migration 017 wrongly DROPPED gpt-5.3-codex on a mistaken belief it had been
-- retired. gpt-5.3-codex is a live Codex-category model (distinct from the
-- mainline gpt-5.4). This migration restores it and expands the allowlist to
-- the full Codex model family, alongside the gpt-5.6 flagship trio and the
-- gpt-5.4 line. The allowlist IS the Codex model menu (/codex/v1/models serves
-- it), so this is the set Codex users can select.
--
-- Rates: OpenAI Standard per-1M prices in micros-per-million (1_000_000 = $1),
-- verified against the published pricing. cache_write_micros = 1.25x the input
-- rate for the GPT-5.6 family (documented cache-write premium) and 0 for every
-- pre-5.6 model (no cache-write fee; those models never emit cache_write_tokens).
--
-- Context-tier caveat (unchanged from 017): the gpt-5.4 line publishes a
-- "<272K context length" tier; the proxy prices a flat rate per model, so
-- >272K-input requests bill at the <272K rate (a bounded under-charge).
--
-- Idempotent upsert; converges every environment onto this corrected set.

BEGIN;

INSERT INTO developer_proxy_vendor_config (vendor, base_url, allowed_models, pricing, enabled)
VALUES (
  'openai',
  'https://api.openai.com',
  ARRAY[
    'gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna',
    'gpt-5.4','gpt-5.4-mini','gpt-5.4-nano',
    'gpt-5.3-codex','gpt-5.2-codex','gpt-5.1-codex-max','gpt-5.1-codex','gpt-5-codex','gpt-5.1-codex-mini','codex-mini-latest'
  ],
  '{
    "gpt-5.6-sol":        {"in_micros": 5000000, "out_micros": 30000000, "cache_read_micros": 500000, "cache_write_micros": 6250000},
    "gpt-5.6-terra":      {"in_micros": 2500000, "out_micros": 15000000, "cache_read_micros": 250000, "cache_write_micros": 3125000},
    "gpt-5.6-luna":       {"in_micros": 1000000, "out_micros":  6000000, "cache_read_micros": 100000, "cache_write_micros": 1250000},
    "gpt-5.4":            {"in_micros": 2500000, "out_micros": 15000000, "cache_read_micros": 250000, "cache_write_micros": 0},
    "gpt-5.4-mini":       {"in_micros":  750000, "out_micros":  4500000, "cache_read_micros":  75000, "cache_write_micros": 0},
    "gpt-5.4-nano":       {"in_micros":  200000, "out_micros":  1250000, "cache_read_micros":  20000, "cache_write_micros": 0},
    "gpt-5.3-codex":      {"in_micros": 1750000, "out_micros": 14000000, "cache_read_micros": 175000, "cache_write_micros": 0},
    "gpt-5.2-codex":      {"in_micros": 1750000, "out_micros": 14000000, "cache_read_micros": 175000, "cache_write_micros": 0},
    "gpt-5.1-codex-max":  {"in_micros": 1250000, "out_micros": 10000000, "cache_read_micros": 125000, "cache_write_micros": 0},
    "gpt-5.1-codex":      {"in_micros": 1250000, "out_micros": 10000000, "cache_read_micros": 125000, "cache_write_micros": 0},
    "gpt-5-codex":        {"in_micros": 1250000, "out_micros": 10000000, "cache_read_micros": 125000, "cache_write_micros": 0},
    "gpt-5.1-codex-mini": {"in_micros":  250000, "out_micros":  2000000, "cache_read_micros":  25000, "cache_write_micros": 0},
    "codex-mini-latest":  {"in_micros": 1500000, "out_micros":  6000000, "cache_read_micros": 375000, "cache_write_micros": 0}
  }'::jsonb,
  TRUE
)
ON CONFLICT (vendor) DO UPDATE SET
  allowed_models = EXCLUDED.allowed_models,
  pricing        = EXCLUDED.pricing,
  enabled        = TRUE;

COMMIT;
