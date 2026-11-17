-- Tool classification seeds for gloria's 2 PREMIUM (x402-gated) MCP tools.
--
-- The connector-service gloria executor now serves get_enriched_news and
-- get_ticker_summary through the x402 transport — the tool call's 402 is paid
-- per call in USDC from the platform wallet, and the settled amount books to
-- cost_attribution_events as cost_bucket='x402_wallet_funded' (migration 440).
-- Payment changes nothing about classification: both are read-only news
-- reads, classified exactly like the 5 free siblings migration 438 seeded.
--
-- classify:tools --connector gloria --from-registry via the LLM relay
-- classifies all 7 gloria tools read-only; these are the 2 rows 438
-- did not carry. Both names are distinct from every prior seed (verified
-- against the migrations tree). tool_classification_cache is UNIQUE on
-- (tool_name, COALESCE(tenant_id,'__global__')); matched on tool_name alone.
--
-- Numbered 441: 440 (x402 cost bucket) is its sibling in this change. Never
-- edit once applied.

INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('get_enriched_news', 'gloria', 'b74e3534b0c6', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_ticker_summary', 'gloria', 'd30a82f9590a', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      classified_at = NOW();
