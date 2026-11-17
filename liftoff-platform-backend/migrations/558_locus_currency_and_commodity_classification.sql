-- Tool classification for the four capabilities the locus rung gains when the
-- account enables the aggregator's free currency and commodity endpoints:
-- the tradeable pair and commodity directories, and the daily closing rate and
-- price for one of each.
--
-- Every one is a public-data READ that changes nothing in the workspace's own
-- systems, so each is a reviewed, category-less classification exactly as
-- migrations 498, 502, 503, 505 and 526 gave this rung's earlier functions. The
-- hash is sha256 of the function's registry description, first twelve hex
-- characters; the manual-override mark means a later description edit does not
-- send the row back to the classifier.
--
-- These four are the platform's first exchange-rate and commodity coverage of
-- any kind. The aggregator lists all four FREE, so they cost the platform
-- nothing and the customer nothing: the charge the aggregator reports is what
-- is booked, and on a free endpoint that is zero.
--
-- Idempotent.

INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('currency_pair_directory', 'locus', 'ddd92cd58cd3', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('currency_daily_exchange_rate', 'locus', '8a2b9b5a325e', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('commodity_directory', 'locus', '54909dbb0971', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('commodity_daily_price', 'locus', '18ac2468233a', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL)
ON CONFLICT (tool_name, COALESCE(integration_type, ''), COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      is_manual_override = EXCLUDED.is_manual_override,
      classified_at = NOW();
