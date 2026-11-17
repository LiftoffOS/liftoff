-- Tool classification seeds for gloria's 5 FREE MCP tools.
--
-- gloria is served by a native MCP-client executor (connector-service
-- src/clients/gloria-mcp.ts) over gloria's keyless public MCP
-- (mcp.itsgloria.ai). These 5 free tools classify read-only; gloria's 2
-- premium tools (get_enriched_news, get_ticker_summary) are x402-gated and are
-- NOT served yet, so they are intentionally absent here. Removes 'gloria' from
-- CLASSIFICATION_PENDING in src/__tests__/smoke/classification-coverage.test.ts.
--
-- classify:tools --connector gloria --from-registry via the LLM relay. All 5
-- names are distinct from every prior seed (verified against the migrations
-- tree). tool_classification_cache is UNIQUE on (tool_name,
-- COALESCE(tenant_id,'__global__')); matched on tool_name alone.
--
-- Numbered 438: 437 is the highest on origin/main. Never edit once applied.

INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('get_categories', 'gloria', '622039c88537', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_latest_news', 'gloria', 'affd6c793361', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_news_recap', 'gloria', '2d588f449640', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('search_news', 'gloria', '4ada445ce0c3', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_news_item', 'gloria', '04181a06b1c4', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      classified_at = NOW();
