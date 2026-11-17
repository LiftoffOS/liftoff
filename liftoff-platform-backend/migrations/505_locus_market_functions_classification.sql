-- Tool classification for three more functions on the locus aggregator rung:
-- a stock's key statistics, a fund's top holdings and ticker lookup, served
-- through Locus's Parse endpoints at a fixed charge. Each reads public
-- market data and changes nothing in the workspace's own systems: a
-- reviewed, category-less classification, as migrations 498, 502 and 503
-- gave the rung's earlier functions. Hashes are sha256 of each function's
-- registry description, first twelve hex characters; the manual-override
-- mark means a later description edit does not send the row back to the
-- classifier. Idempotent.

INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('stock_key_statistics', 'locus', 'daef7528ee4f', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('fund_top_holdings', 'locus', '2583ac5fb781', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('ticker_lookup', 'locus', '09b865a19667', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL)
ON CONFLICT (tool_name, COALESCE(integration_type, ''), COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      is_manual_override = EXCLUDED.is_manual_override,
      classified_at = NOW();
