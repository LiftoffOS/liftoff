-- Tool classification for Hunter.io's NATIVE REST tools.
--
-- Hunter moved from a composio_managed connector to a native REST executor
-- (connector-service src/clients/hunter.ts) over api.hunter.io/v2, exposing only
-- the curated lead-gen surface (enumerated 2026-09-11). The native function
-- names differ from the composio overlay names seeded in migration 453 (which
-- stay as dead, harmless rows). The executor fail-closes on a missing
-- classification, so every native tool needs a row.
--
-- Every function is a READ (a data lookup) — domain/email search, enrichment,
-- people discovery, account/usage — so none is human-approval gated (empty
-- category array). Hunter meters credits per call; that is a balance concern
-- (fail-closed when exhausted, no auto-reload), not a gating one, and does not
-- change the read classification.
-- classification is keyed on tool_name alone; ON CONFLICT re-asserts categories.

INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('domain_search', 'hunterio', 'hun0native01', ARRAY[]::TEXT[], NULL, 'native-hunter-rest', true, NULL),
  ('email_finder', 'hunterio', 'hun0native02', ARRAY[]::TEXT[], NULL, 'native-hunter-rest', true, NULL),
  ('email_verifier', 'hunterio', 'hun0native03', ARRAY[]::TEXT[], NULL, 'native-hunter-rest', true, NULL),
  ('email_count', 'hunterio', 'hun0native04', ARRAY[]::TEXT[], NULL, 'native-hunter-rest', true, NULL),
  ('company_enrichment', 'hunterio', 'hun0native05', ARRAY[]::TEXT[], NULL, 'native-hunter-rest', true, NULL),
  ('person_enrichment', 'hunterio', 'hun0native06', ARRAY[]::TEXT[], NULL, 'native-hunter-rest', true, NULL),
  ('combined_enrichment', 'hunterio', 'hun0native07', ARRAY[]::TEXT[], NULL, 'native-hunter-rest', true, NULL),
  ('find_people', 'hunterio', 'hun0native08', ARRAY[]::TEXT[], NULL, 'native-hunter-rest', true, NULL),
  ('get_account', 'hunterio', 'hun0native09', ARRAY[]::TEXT[], NULL, 'native-hunter-rest', true, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      integration_type = EXCLUDED.integration_type,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      classified_at = NOW();
