-- Elicit tool classification — regenerated via the (now-fixed) classify:tools
-- pipeline (scripts/classify-connector-tools.ts --connector elicit --from-registry).
--
-- Supersedes migration 282 (which was hand-authored). The pipeline (platform LLM classifier) agrees with 282 on
-- 7 of 8 tools; the difference is create_report:
--   282 (hand-authored): create_report -> ['dataChanges'] (HITL)
--   here  (pipeline):     create_report -> []            (read-only, no HITL)
-- Per product decision, report generation is a core research action and should
-- not require per-call human approval, so we adopt the pipeline's classification.
-- create_systematic_review stays ['dataChanges'] (heavier managed pipeline).
--
-- ON CONFLICT (tool_name, COALESCE(tenant_id,'__global__')) DO UPDATE — updates
-- the rows seeded in 282. Hashes = sha256(runtime description)[:12] (unchanged;
-- same descriptions), so the tool-classifier lookup stays a cache hit.

INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('search_papers', 'elicit', 'efa43335b62c', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('search_clinical_trials', 'elicit', '2671d059e424', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('create_report', 'elicit', '1966fa5d2a08', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_report', 'elicit', 'd13e16de8edd', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_reports', 'elicit', 'fe256806d1d3', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('create_systematic_review', 'elicit', '52666ba44160', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_systematic_review', 'elicit', '5c36cf0c79db', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_systematic_reviews', 'elicit', '985ab591f1e2', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      classified_at = NOW();
