-- Tool classification for the thirteen prediction and event market reads the
-- vaaya rung offers.
--
-- WHY THIRTEEN AND NOT A HUNDRED AND THREE. The rung's catalog advertises 103
-- paths for this upstream, but only thirteen return data when called; the rest
-- answer 502 upstream_error, are rejected as malformed, or need a path
-- parameter the catalog row does not carry.
-- The whole crypto-intelligence half -- order books, liquidations, funding
-- history, on-chain indicators, fund and token analytics -- is in the 502s, so
-- it is not mapped and is not counted as coverage. Only what answers is here.
--
-- Every one is a public-data read that changes nothing in the workspace's own
-- systems: a reviewed, category-less classification, as migrations 498, 502,
-- 503, 505, 526 and 528 gave the other rungs. The hash is sha256 of the
-- function's registry description, first twelve hex characters.
--
-- Four of the thirteen duplicate prediction-market reads migration 526 already
-- classified on another rung. That is deliberate: two routes to the same data
-- is a fallback, and this one settles on the aggregator's own prepaid balance
-- rather than the platform's x402 wallet.
--
-- Idempotent.

INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('event_contract_listings', 'vaaya', '50b28da8022b', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_market_listings', 'vaaya', '59ff753c9890', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('opinion_market_listings', 'vaaya', 'f856a490a508', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_contest_listings', 'vaaya', '92099af2bf98', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_market_board', 'vaaya', 'e52095089d0a', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_market_page', 'vaaya', '1d42690e388e', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_event_board', 'vaaya', '367d66707e64', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_event_page', 'vaaya', 'b53789ee5711', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_market_leaders', 'vaaya', '3eaa11665f7e', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_market_positions', 'vaaya', 'd0d90de041d6', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_market_trades', 'vaaya', '64bbc7a433b9', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_trader_cohorts', 'vaaya', 'e2c7f2b6058b', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('crypto_updown_markets', 'vaaya', '186e19c99240', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL)
ON CONFLICT (tool_name, COALESCE(integration_type, ''), COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      is_manual_override = EXCLUDED.is_manual_override,
      classified_at = NOW();
