-- Tool classification for the last two of the supplier's thirty-four
-- prediction-market operations.
--
-- BOTH WERE REPORTED AS BROKEN AND NEITHER IS. Migration 539 left them out
-- because every call returned an error. Both errors were ours:
--
--   The resolution record takes the market's CONDITION identifier, not its
--   question identifier, and only returns a record while the market is still
--   unsettled. It had been tried as condition-on-closed and question-on-open,
--   never condition-on-open, which is the pair that works. Confirmed on three
--   separate open markets.
--
--   The smart-money read is refused below thresholds the source enforces and
--   its schema does not publish: 10000 traded, 100 trades, 0.15 return, 5000
--   profit. Every filter tried was under them. At or above them it answers.
--
-- So all thirty-four operations answer, and the fifty-three reads on this rung
-- are now fifty-five. Both thresholds and the identifier rule are written into
-- the argument descriptions, so a model does not have to learn them from a
-- refusal.
--
-- Public-data reads that change nothing in the workspace's own systems: a
-- reviewed, category-less classification, as migrations 498 through 539 gave
-- the rest. The hash is sha256 of the function's registry description, first
-- twelve hex characters. Idempotent.

INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('prediction_market_resolution', 'vaaya', '00cd298bc310', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('prediction_smart_money_markets', 'vaaya', '65f297b2e7fb', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL)
ON CONFLICT (tool_name, COALESCE(integration_type, ''), COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      is_manual_override = EXCLUDED.is_manual_override,
      classified_at = NOW();
