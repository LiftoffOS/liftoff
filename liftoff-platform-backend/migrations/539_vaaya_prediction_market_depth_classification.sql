-- Tool classification for the nineteen prediction-market and crypto-price
-- reads the vaaya rung gained after its upstream republished.
--
-- WHAT CHANGED UPSTREAM. Migration 535 mapped thirteen of the 103 paths this
-- supplier then advertised; the other ninety did not answer. The supplier has
-- since retired the routes that were dead, fixed
-- path-parameter substitution, and republished 34 working operations. These
-- nineteen are the ones migration 535 could not have: the order book, open
-- interest, the price and volume of a single contract, the wallet-level reads
-- (a trader's activity, profit and loss, markets, cluster and lookalikes),
-- regulated event-contract books and trades, and crypto candles and ticks.
--
-- TWO OF THE 34 ARE DELIBERATELY ABSENT. One answers 404 for every identifier
-- we can give it, open market and closed, on both identifier spellings; the
-- other answers 400 for every filter its own error message names. They are
-- raised with the supplier and will be added when they answer, not before.
--
-- Every one of the nineteen was called before this was written. Three more
-- looked broken and were not: they fail against a stale identifier and work
-- against a live one, which matters because ninety-three of the first hundred
-- markets the listing returns are closed, so the obvious seed misleads.
--
-- Every one is a public-data read that changes nothing in the workspace's own
-- systems: a reviewed, category-less classification, as migrations 498, 502,
-- 503, 505, 526, 528, 535 and 536 gave the other rungs. The hash is sha256 of
-- the function's registry description, first twelve hex characters.
--
-- Idempotent.

INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('prediction_market_search', 'vaaya', '5068f6829725', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_market_orderbook', 'vaaya', '27a4e3571502', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_contract_price', 'vaaya', 'fd1038863b9c', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_contract_volume', 'vaaya', '8a709d006f42', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_market_open_interest', 'vaaya', '5591fa869cc8', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_market_volume_history', 'vaaya', 'dfc8ccaed2eb', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_market_top_traders', 'vaaya', '375fc3c0fc06', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_trader_activity', 'vaaya', 'd8c154b63d86', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_trader_pnl', 'vaaya', '1cf32df97bc5', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_trader_volume_history', 'vaaya', 'b7da3230e7ce', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_trader_markets', 'vaaya', '1ef7653f1697', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_trader_identity', 'vaaya', '942ff568b9ad', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_trader_identities', 'vaaya', '82aa23749b67', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_trader_cluster', 'vaaya', 'eda76f2855f1', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_similar_traders', 'vaaya', 'c83f5b0b5508', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('event_contract_orderbook', 'vaaya', '0a9d6044497e', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('event_contract_trades', 'vaaya', '67f431d09f27', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('crypto_price_candles', 'vaaya', '78929321717e', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('crypto_price_ticks', 'vaaya', '751626b7a6d0', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL)
ON CONFLICT (tool_name, COALESCE(integration_type, ''), COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      is_manual_override = EXCLUDED.is_manual_override,
      classified_at = NOW();
