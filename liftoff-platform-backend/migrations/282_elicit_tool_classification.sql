-- Elicit native connector tool classification (fresh full seed, no baseline).
--
-- Seeds tool_classification_cache for the 8 tools the tool-gateway serves via the
-- connector-service /elicit sidecar (ELICIT_FUNCTIONS). Hashes are
-- sha256(runtime tool description).slice(0,12) computed from
-- getConnectorFunctions('elicit'), so the runtime lookup (tool-classifier.ts,
-- keyed by tool_name) is a cache HIT (no fallback to LLM classification).
--
-- Categories:
--   read-only tools (search_papers, search_clinical_trials, get_report,
--     list_reports, get_systematic_review, list_systematic_reviews) -> []
--   report/review creation (create_report, create_systematic_review), which
--     kicks off an asynchronous Elicit job -> ['dataChanges'] (write)
-- Elicit exposes no destructive or financial operations.
--
-- Note: get_report / list_reports are generic names also seeded (as []) under
-- namely + bamboohr. The cache is keyed globally by tool_name, so the ON CONFLICT
-- below is last-writer-wins across connectors — benign here because all three
-- classify these read tools as [] (identical categories; no security change).

INSERT INTO tool_classification_cache
  (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('search_papers', 'elicit', 'efa43335b62c', ARRAY[]::TEXT[], NULL, 'elicit-native-v1', false, NULL),
  ('search_clinical_trials', 'elicit', '2671d059e424', ARRAY[]::TEXT[], NULL, 'elicit-native-v1', false, NULL),
  ('create_report', 'elicit', '1966fa5d2a08', ARRAY['dataChanges']::TEXT[], NULL, 'elicit-native-v1', false, NULL),
  ('get_report', 'elicit', 'd13e16de8edd', ARRAY[]::TEXT[], NULL, 'elicit-native-v1', false, NULL),
  ('list_reports', 'elicit', 'fe256806d1d3', ARRAY[]::TEXT[], NULL, 'elicit-native-v1', false, NULL),
  ('create_systematic_review', 'elicit', '52666ba44160', ARRAY['dataChanges']::TEXT[], NULL, 'elicit-native-v1', false, NULL),
  ('get_systematic_review', 'elicit', '5c36cf0c79db', ARRAY[]::TEXT[], NULL, 'elicit-native-v1', false, NULL),
  ('list_systematic_reviews', 'elicit', '985ab591f1e2', ARRAY[]::TEXT[], NULL, 'elicit-native-v1', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      integration_type = EXCLUDED.integration_type,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      classified_at = NOW();
