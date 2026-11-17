-- Migration 518: tool classification for the keyless DeFi data card.
--
-- connector-service's `defillama` card (5b58105) reads the vendor's free,
-- open API: protocol and chain value locked, token prices, stablecoin supply,
-- pool yields, exchange volume and protocol fees. Every function reads public
-- market data and changes nothing in the workspace's own systems: a reviewed,
-- category-less classification, as migrations 498, 502, 503, 505 and 514 gave
-- the other public-data rungs. Hashes are sha256 of each function's registry
-- description, first twelve hex characters; the manual-override mark means a
-- later description edit does not send the row back to the classifier.
-- Idempotent. 15 rows.

INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('defi_protocols_search', 'defillama', '27f25660611f', ARRAY[]::TEXT[], NULL, 'manual-keyless-reads', true, NULL),
  ('defi_protocol_tvl', 'defillama', '47323981f467', ARRAY[]::TEXT[], NULL, 'manual-keyless-reads', true, NULL),
  ('defi_protocol_profile', 'defillama', '9a184089afab', ARRAY[]::TEXT[], NULL, 'manual-keyless-reads', true, NULL),
  ('defi_protocol_tvl_history', 'defillama', 'cf2a98811aaf', ARRAY[]::TEXT[], NULL, 'manual-keyless-reads', true, NULL),
  ('defi_chains_tvl', 'defillama', '27e1deaaa978', ARRAY[]::TEXT[], NULL, 'manual-keyless-reads', true, NULL),
  ('defi_chain_tvl_history', 'defillama', '256f6da1be6a', ARRAY[]::TEXT[], NULL, 'manual-keyless-reads', true, NULL),
  ('token_prices_current', 'defillama', 'c58f1e12f55c', ARRAY[]::TEXT[], NULL, 'manual-keyless-reads', true, NULL),
  ('token_price_change', 'defillama', 'b9c4061120df', ARRAY[]::TEXT[], NULL, 'manual-keyless-reads', true, NULL),
  ('stablecoins_list', 'defillama', '5ed74535f7f9', ARRAY[]::TEXT[], NULL, 'manual-keyless-reads', true, NULL),
  ('stablecoin_supply_by_chain', 'defillama', 'ecdc8f27d3a8', ARRAY[]::TEXT[], NULL, 'manual-keyless-reads', true, NULL),
  ('yield_pools_search', 'defillama', 'bbd2598814eb', ARRAY[]::TEXT[], NULL, 'manual-keyless-reads', true, NULL),
  ('dex_volume_overview', 'defillama', 'fb1c62865afe', ARRAY[]::TEXT[], NULL, 'manual-keyless-reads', true, NULL),
  ('dex_protocol_volume', 'defillama', '812f1cb8dc9f', ARRAY[]::TEXT[], NULL, 'manual-keyless-reads', true, NULL),
  ('protocol_fees_overview', 'defillama', 'fb4ff35ee7ba', ARRAY[]::TEXT[], NULL, 'manual-keyless-reads', true, NULL),
  ('protocol_fees', 'defillama', 'aba5092865eb', ARRAY[]::TEXT[], NULL, 'manual-keyless-reads', true, NULL)
ON CONFLICT (tool_name, COALESCE(integration_type, ''), COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      is_manual_override = EXCLUDED.is_manual_override,
      classified_at = NOW();
