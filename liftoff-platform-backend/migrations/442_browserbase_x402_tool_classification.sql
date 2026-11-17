-- Tool classification seeds for browserbase_x402's 2 pay-per-call tools.
--
-- browserbase_x402 is browserbase's x402 gateway (x402.browserbase.com):
-- no account, no key — each call's 402 is paid in USDC from the platform
-- wallet (cost_bucket='x402_wallet_funded', migration 440). DISTINCT from
-- the BYOK 'browserbase' web-tool connector, which is a tenant's own key
-- driven from the tenant runtime and lands nothing here. Both tools are
-- read-only request/response calls; the gateway's session endpoints are
-- deliberately not served.
--
-- classify:tools --connector browserbase_x402 --from-registry via the LLM
-- relay. Both names are distinct from every prior seed (verified
-- against the migrations tree). tool_classification_cache is UNIQUE on
-- (tool_name, COALESCE(tenant_id,'__global__')); matched on tool_name alone.
--
-- Numbered 442: follows 440/441 (x402 bucket + gloria premium) in this
-- change. Never edit once applied.

INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('search_the_web', 'browserbase_x402', '0751e29ea1c1', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('fetch_page_content', 'browserbase_x402', '7fecc8cdc52c', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      classified_at = NOW();
