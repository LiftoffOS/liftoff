-- Tool classification seeds for google_trends' 4 pay-per-call tools.
--
-- google_trends is Google Trends keyword data served through the x402 Atlas
-- (google-trends.use.x402atlas.com): keyless GETs whose 402 challenge is
-- paid in USDC from the platform wallet per call
-- (cost_bucket='x402_wallet_funded', migration 440). All read-only.
--
-- classify:tools --connector google_trends --from-registry via the LLM
-- relay. All 4 names are distinct from every prior seed
-- (verified against the migrations tree). tool_classification_cache is
-- UNIQUE on (tool_name, COALESCE(tenant_id,'__global__')); matched on
-- tool_name alone.
--
-- Numbered 443: follows 442 (browserbase_x402) in the x402 fan-out land
-- order. Never edit once applied.

INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('get_keyword_trend', 'google_trends', 'da6819eb6b91', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_keyword_interest_by_region', 'google_trends', '36f16995d943', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_keyword_related_queries', 'google_trends', 'bfed444e99a2', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_keyword_related_topics', 'google_trends', 'ed5eb92e3d63', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      classified_at = NOW();
