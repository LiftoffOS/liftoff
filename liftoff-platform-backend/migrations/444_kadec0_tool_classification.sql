-- Tool classification seeds for kadec0's 10 curated pay-per-call tools.
--
-- kadec0 (api.kadec0.xyz) is a keyless web search / scraping / market /
-- research data API paid per call via x402 from the platform wallet
-- (cost_bucket='x402_wallet_funded', migration 440). The vendor lists 44
-- endpoints; the connector-service registry curates the 10 head tools (the
-- tikhub discipline) — several of the rest duplicate surfaces already
-- served elsewhere. All read-only.
--
-- classify:tools --connector kadec0 --from-registry via the LLM relay.
-- All 10 names are distinct from every prior seed (verified against the
-- migrations tree). tool_classification_cache is UNIQUE on
-- (tool_name, COALESCE(tenant_id,'__global__')); matched on tool_name alone.
--
-- Numbered 444: follows 443 (google_trends) in the x402 fan-out land order.
-- Never edit once applied.

INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('search_web_serp', 'kadec0', 'f63e7cee2d27', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('scrape_url_markdown', 'kadec0', '7f7a579b8241', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_market_sentiment', 'kadec0', '50b3981e702c', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('search_sec_filings', 'kadec0', '120a39e486e6', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_congress_trades', 'kadec0', 'd9e19e8446df', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_defi_tvl', 'kadec0', 'd7e3753fa718', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_token_price', 'kadec0', '2f1fc611f654', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('search_academic_papers', 'kadec0', '68191f9f1b78', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_domain_info', 'kadec0', '8e29f6def8f8', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('validate_email_address', 'kadec0', 'edd7d7468966', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      classified_at = NOW();
