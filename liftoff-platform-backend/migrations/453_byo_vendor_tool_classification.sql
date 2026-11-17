-- Tool-classification seeds for the BYO composio-managed absorbed vendors
-- (pdl, hunterio, saperly, apify, contactout, crunchbase). Until seeded, every
-- tool fail-secures to HITL, so these could be connected but not cleanly run.
-- Generated via `classify:tools --from-registry` (keyless — the composio
-- overlays carry the tool set) against an LLM relay. Read tools get an
-- empty category array; saperly's outbound call/SMS and apify's write actions
-- carry write/outbound categories and stay HITL-gated by design.

-- pdl
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('enrich_person', 'pdl', 'b5774aea1a9c', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('identify_person', 'pdl', 'aff0453da404', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('search_people', 'pdl', 'ebbbe06a9566', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('enrich_company', 'pdl', '9960b0346e07', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('search_companies', 'pdl', 'c15dbcf5f090', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('enrich_ip', 'pdl', '66f20b2551c4', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('enrich_job_title', 'pdl', '1ed23c1c84e2', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('autocomplete_fields', 'pdl', 'ee8247940b80', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      classified_at = NOW();

-- hunterio
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('domain_search', 'hunterio', '2fc8011f9801', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('find_email', 'hunterio', '0fec2901e061', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('verify_email', 'hunterio', 'd8fafe30476e', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('enrich_company', 'hunterio', 'dc3d012cd827', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('create_lead', 'hunterio', '2e37b15223da', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_lead', 'hunterio', 'a3aa6cb927eb', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_leads', 'hunterio', '0c8d23be9525', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('update_lead', 'hunterio', '78870314ab05', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      classified_at = NOW();

-- saperly
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('provision_number', 'saperly', '72ed984255a3', ARRAY['financialActions', 'dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('release_number', 'saperly', 'ad1b7aea2b14', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_number', 'saperly', '3a3cb3ac5295', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_numbers', 'saperly', '2709d9f4a45a', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('quote_number_price', 'saperly', '55a7b2c64a9f', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('set_number_caller_id', 'saperly', 'ac27abdf47dc', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('set_number_sms_sender', 'saperly', 'aaf0c7a22a3a', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('place_call', 'saperly', 'bb02c9d936db', ARRAY['customerCommunication', 'financialActions']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('transfer_call', 'saperly', 'ba3da0654b2f', ARRAY['financialActions', 'dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('end_call', 'saperly', '669a5aaef97c', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_call', 'saperly', '9f898ee7751f', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_calls', 'saperly', '7b383a66c972', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_call_recording', 'saperly', 'fbf7d3b9abc3', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_call_transcript', 'saperly', 'e40ff3bb1e11', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('send_sms', 'saperly', '416c6fde506d', ARRAY['customerCommunication', 'financialActions']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_messages', 'saperly', '983817dec4a8', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('check_consent', 'saperly', 'c096a2dd60ff', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_consent', 'saperly', 'c1afc47281dd', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('record_consent', 'saperly', '16051e5843a8', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('revoke_consent', 'saperly', 'ab3c87c49160', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('create_connection', 'saperly', '8c7c0053aa7e', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_connection', 'saperly', 'c730c4febfa9', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_connections', 'saperly', 'bbde1a832ceb', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('update_connection', 'saperly', 'c5a15a0abe84', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('delete_connection', 'saperly', '601e4e75f1ea', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('assign_number_connection', 'saperly', 'ee90da3199fd', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_usage', 'saperly', '2d7b98cc46f8', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_languages', 'saperly', '3a574cbe80ee', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_voices', 'saperly', '4159737525fa', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      classified_at = NOW();

-- apify
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('run_actor_get_items', 'apify', 'b00652fb36d8', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('run_actor', 'apify', '6bbad1fef805', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('run_task', 'apify', '2c59cc8eb4e2', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_dataset_items', 'apify', 'b3754f0729dd', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_runs', 'apify', 'df0a18bcf00c', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_actor', 'apify', 'de20cb8dcc73', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_run_log', 'apify', '9f985c50fd0f', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_tasks', 'apify', '003fa4b57700', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_key_value_record', 'apify', '3ac8cbf1aec4', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      classified_at = NOW();

-- contactout
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('enrich_from_linkedin_url', 'contactout', '19429da57491', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('enrich_from_email', 'contactout', '323220e1df60', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('search_people', 'contactout', 'a1c932c2a9a5', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_email_status', 'contactout', 'bc0ae55f1262', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      classified_at = NOW();

-- crunchbase
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('get_organization', 'crunchbase', '9e3d24bf71c9', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_person', 'crunchbase', '757b3fc99adc', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_funding_round', 'crunchbase', '0aa2ffdb4cfb', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('search_organizations', 'crunchbase', '041eddfc8015', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('search_funding_rounds', 'crunchbase', 'eed2e3f8be15', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('autocomplete', 'crunchbase', 'cd74c089cf05', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      classified_at = NOW();
