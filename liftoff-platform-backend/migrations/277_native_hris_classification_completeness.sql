-- Native HRIS classification — completeness fix (delta over migration 276).
-- Migration 276 seeded only the spec-GENERATED tools. The runtime set agents see
-- is mergeTools(hand-authored <VENDOR>_FUNCTIONS, generated), so the curated
-- first-class tools and every {vendor}_native_request passthrough had NO seed
-- (would hit runtime LLM classification), plus 3 SAP names collided (hand-authored
-- description won the merge → 276's generated hash never matched). This seeds the
-- full runtime set's delta with hashes computed from the RUNTIME descriptions.
-- read -> []; write/destructive -> ['dataChanges'] (+ 'financialActions' on
-- pay/comp/tax/bank); {vendor}_native_request passthrough -> always-HITL
-- ['dataChanges','financialActions','customerCommunication'] (can call any endpoint).
-- Regenerate: scripts/audit-hris-classification.ts (imports NATIVE_HRIS_FUNCTIONS).

INSERT INTO tool_classification_cache
  (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('list_profiles', 'namely', 'b26a2f34e85f', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('get_profile', 'namely', '143d17fe015a', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('create_profile', 'namely', '9a6e0db69f8f', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('update_profile', 'namely', '095b9b47079b', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('deactivate_profile', 'namely', 'fe7f90315194', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_job_titles', 'namely', '1771e8885e04', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_groups', 'namely', '43f3dc664213', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('get_group', 'namely', 'eca33ce8ca3d', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_events', 'namely', 'c3276ba24a34', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_reports', 'namely', 'f9a2211145e8', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('get_report', 'namely', '83b7115c1253', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_profile_fields', 'namely', '4864e41dca34', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('namely_native_request', 'namely', 'bd233e1d3594', ARRAY['dataChanges','financialActions','customerCommunication']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      integration_type = EXCLUDED.integration_type,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      classified_at = NOW();

INSERT INTO tool_classification_cache
  (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('list_workers', 'workday', '1a87c48bb53a', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('get_worker', 'workday', 'd4f5fd459152', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('run_wql', 'workday', '86fd638cb5cf', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('update_worker', 'workday', '83146853deaa', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('submit_business_process', 'workday', 'aa9eef96002a', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('workday_native_request', 'workday', '51002fbf9740', ARRAY['dataChanges','financialActions','customerCommunication']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      integration_type = EXCLUDED.integration_type,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      classified_at = NOW();

INSERT INTO tool_classification_cache
  (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('list_emps', 'oracle_hcm', '48fc17e1a9b4', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_departments', 'oracle_hcm', '5ca07d3394b0', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_locations', 'oracle_hcm', 'c5d8b5091486', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_positions', 'oracle_hcm', 'eb41bfe40a45', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_jobs', 'oracle_hcm', '50b18e66ed98', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_grades', 'oracle_hcm', '614df71d113d', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('create_worker', 'oracle_hcm', '31f0a38c2c8c', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('oracle_hcm_native_request', 'oracle_hcm', '2cf94b7dd76a', ARRAY['dataChanges','financialActions','customerCommunication']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      integration_type = EXCLUDED.integration_type,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      classified_at = NOW();

INSERT INTO tool_classification_cache
  (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('list_users', 'sap_successfactors', 'a3d7e3d8c0dc', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('get_user', 'sap_successfactors', '6cba4377cec1', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_employments', 'sap_successfactors', '431e6b4d7517', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_compensations', 'sap_successfactors', 'c1d0a8a97cdf', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_pay_components', 'sap_successfactors', '49127b7223f7', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_persons', 'sap_successfactors', '1271877f4578', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_employee_time', 'sap_successfactors', 'bd8b7cbb0b99', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('get_employment', 'sap_successfactors', '47de4a78364b', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('get_job', 'sap_successfactors', '4dec51ec598d', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('get_compensation', 'sap_successfactors', 'dce8bc2fd57e', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('get_pay_component', 'sap_successfactors', '44ecd37e7b47', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('get_person', 'sap_successfactors', 'bdcf799df118', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('get_personal', 'sap_successfactors', '7c022c31c562', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('get_employee_time', 'sap_successfactors', '43c2d292e16d', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('create_user', 'sap_successfactors', '8ec84ddb666c', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('update_user', 'sap_successfactors', '136552432301', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('create_employment', 'sap_successfactors', 'eade725340b0', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('update_employment', 'sap_successfactors', '592200e7ff01', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('create_job', 'sap_successfactors', 'b7576706f89b', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('update_job', 'sap_successfactors', 'ca5e488d9ea0', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('create_compensation', 'sap_successfactors', '3eea1d8ded03', ARRAY['financialActions','dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('update_compensation', 'sap_successfactors', 'e82edc2cf34a', ARRAY['financialActions','dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('create_pay_component', 'sap_successfactors', '5c6ce96cb606', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('update_pay_component', 'sap_successfactors', '46a98c4022fa', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('create_person', 'sap_successfactors', '46a3611f46b8', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('update_person', 'sap_successfactors', '30e725d166ab', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('create_personal', 'sap_successfactors', 'fecb1cded6e1', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('update_personal', 'sap_successfactors', '3f915c13838c', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('create_employee_time', 'sap_successfactors', 'b519bf2a01a7', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('update_employee_time', 'sap_successfactors', '40124a2c162b', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('sap_successfactors_native_request', 'sap_successfactors', 'f62e202af80a', ARRAY['dataChanges','financialActions','customerCommunication']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      integration_type = EXCLUDED.integration_type,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      classified_at = NOW();
