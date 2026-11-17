-- Tool classification for the thirty-two capabilities the locus rung gained
-- when the account enabled six more providers: crypto market
-- data, search-engine and keyword data, wallet and token intelligence,
-- prediction and event markets, and two market signals.
--
-- Every one is a public-data READ that changes nothing in the workspace's own
-- systems, so each is a reviewed, category-less classification exactly as
-- migrations 498, 502, 503 and 505 gave this rung's earlier functions. The
-- hash is sha256 of the function's registry description, first twelve hex
-- characters; the manual-override mark means a later description edit does
-- not send the row back to the classifier.
--
-- The rung matters to how these are PAID for: all thirty-two are reached
-- through the aggregator, so the charge lands on its prepaid credit balance
-- and the platform's own x402 wallet is never touched -- on the x402 lanes it
-- resells, the aggregator is the purchaser. That is what keeps this
-- pay-as-you-go with no monthly commitment.
--
-- Idempotent.

INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('crypto_price_now', 'locus', 'cad1f1372933', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('crypto_token_price_by_contract', 'locus', '870c6384c8bc', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('crypto_market_table', 'locus', '9422401561e0', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('crypto_coin_profile', 'locus', '2d11997bc8d3', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('crypto_coin_directory', 'locus', '1cf12b5a2fb3', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('crypto_search', 'locus', 'a034b8448b63', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('crypto_trending', 'locus', '114fee86fa60', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('crypto_exchange_rates', 'locus', '5b620cb77317', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('crypto_global_market', 'locus', 'd6cbc89d9cf8', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('crypto_global_defi_market', 'locus', '706841c1f6de', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('crypto_price_history', 'locus', 'f2c2f85cd410', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('crypto_price_on_date', 'locus', '3551c6fd7204', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('crypto_categories', 'locus', '4c653d1892c0', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('crypto_top_movers', 'locus', '5b2517c25bf7', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('crypto_exchanges', 'locus', '32c526ef3844', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('search_ranking_results', 'locus', '187d3182b282', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('keyword_search_volume', 'locus', 'a8434cd4c80e', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('wallet_token_balances', 'locus', '8cf21b0bdd2a', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('wallet_balance_history', 'locus', '9c815521b0c8', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('wallet_token_pnl', 'locus', '59cfbe920411', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('wallet_pnl_summary', 'locus', '375481b10977', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('wallet_related_addresses', 'locus', 'e5d9abdbcc16', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('wallet_transactions', 'locus', '35227ef8a1e9', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('token_flow_analysis', 'locus', '8f260247ac8b', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('token_buyers_and_sellers', 'locus', 'cd970bd2aeb7', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('event_contract_markets', 'locus', '8e3f3c61028c', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_market_events', 'locus', 'b95255d2896e', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_market_traders', 'locus', '66e83a564aee', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_market_quotes', 'locus', 'd32e0e076475', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('us_stock_symbols', 'locus', 'b3f27bf00cad', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('crypto_fear_greed_index', 'locus', '60ecadfffde7', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('bitcoin_price_forecast', 'locus', '5ac5bbcf183c', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL)
ON CONFLICT (tool_name, COALESCE(integration_type, ''), COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      is_manual_override = EXCLUDED.is_manual_override,
      classified_at = NOW();
