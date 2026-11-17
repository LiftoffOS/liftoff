-- Clay.com (clay) tool classification seeds — 16 tools enumerated via tools/list
-- Rules-based, conservative per the classify-script CLASSIFICATION_SYSTEM_PROMPT:
--   read/get/list/query  -> [] (no HITL category)
--   find/enrich/add/run/track (state-changing, credit-consuming) -> ['dataChanges']
INSERT INTO tool_classification_cache
  (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('find-and-enrich-contacts-at-company', 'clay', '2f3abc7ed41d', ARRAY['dataChanges']::TEXT[], NULL, 'manual-clay-rules-v1', false, NULL),
  ('find-and-enrich-list-of-contacts', 'clay', '8f43d17243aa', ARRAY['dataChanges']::TEXT[], NULL, 'manual-clay-rules-v1', false, NULL),
  ('find-and-enrich-company', 'clay', '39050f8269c4', ARRAY['dataChanges']::TEXT[], NULL, 'manual-clay-rules-v1', false, NULL),
  ('add-contact-data-points', 'clay', 'cb35f57a656c', ARRAY['dataChanges']::TEXT[], NULL, 'manual-clay-rules-v1', false, NULL),
  ('add-company-data-points', 'clay', '9aa000d2d46f', ARRAY['dataChanges']::TEXT[], NULL, 'manual-clay-rules-v1', false, NULL),
  ('get-credits-available', 'clay', '96815a14050f', ARRAY[]::TEXT[], NULL, 'manual-clay-rules-v1', false, NULL),
  ('get-task', 'clay', '3e51d59c41ca', ARRAY[]::TEXT[], NULL, 'manual-clay-rules-v1', false, NULL),
  ('get-task-context', 'clay', '8ec61841288f', ARRAY[]::TEXT[], NULL, 'manual-clay-rules-v1', false, NULL),
  ('track-event', 'clay', '529565517acf', ARRAY['dataChanges']::TEXT[], NULL, 'manual-clay-rules-v1', false, NULL),
  ('run_subroutine_no_mapping', 'clay', '607ab5093219', ARRAY['dataChanges']::TEXT[], NULL, 'manual-clay-rules-v1', false, NULL),
  ('get_subroutine_input_options', 'clay', '9989b9081768', ARRAY[]::TEXT[], NULL, 'manual-clay-rules-v1', false, NULL),
  ('list_subroutines', 'clay', '0ffc79f5050d', ARRAY[]::TEXT[], NULL, 'manual-clay-rules-v1', false, NULL),
  ('run_subroutine', 'clay', '3e5aa56681aa', ARRAY['dataChanges']::TEXT[], NULL, 'manual-clay-rules-v1', false, NULL),
  ('run_subroutine_direct', 'clay', '7fdb7a031e6d', ARRAY['dataChanges']::TEXT[], NULL, 'manual-clay-rules-v1', false, NULL),
  ('ask-question-about-accounts', 'clay', '9c722922a4da', ARRAY[]::TEXT[], NULL, 'manual-clay-rules-v1', false, NULL),
  ('query-objects', 'clay', '941b30574799', ARRAY[]::TEXT[], NULL, 'manual-clay-rules-v1', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      classified_at = NOW();
