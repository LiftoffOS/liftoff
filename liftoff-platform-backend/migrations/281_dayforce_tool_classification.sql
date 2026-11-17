-- Native HRIS classification seeds for: dayforce (delta over the baseline at SEED_MIGRATION_PATH).
-- Seeds tool_classification_cache for the RUNTIME native tool set each agent sees:
-- NATIVE_HRIS_FUNCTIONS[type] = mergeTools(hand-authored <VENDOR>_FUNCTIONS, generated).
-- Hashes are sha256(runtime description).slice(0,12) so the runtime lookup is a cache
-- HIT (no fallback to LLM classification). Categories:
--   read -> []; write/destructive -> ['dataChanges'] (+ 'financialActions' on
--   pay/comp/tax/bank paths); {vendor}_native_request passthrough -> always-HITL
--   ['dataChanges','financialActions','customerCommunication'] (can call any endpoint).
-- Regenerate: HRIS_CLASSIFICATION_CONNECTORS=<csv> (or AUDIT_HRIS_CONNECTORS)
-- SEED_MIGRATION_PATH=<seed> scripts/audit-hris-classification.ts <out.sql>.

INSERT INTO tool_classification_cache
  (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('list_employees', 'dayforce', 'ad08c1a418a2', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('get_employee', 'dayforce', 'c3b163c8b6d1', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('create_employee', 'dayforce', '8139480682e5', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('update_employee', 'dayforce', '7c28331e4f95', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('get_employee_work_assignments', 'dayforce', '6ccb568d2faa', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('get_employee_compensation', 'dayforce', '65028f8fc89b', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('get_employee_dependents', 'dayforce', '909a7c0e6022', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('get_employee_time_away', 'dayforce', 'db64a49b255c', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_pay_summaries', 'dayforce', '5ce0cb8fbae1', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_pay', 'dayforce', '3e6e93adf3f0', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('create_pay_adjustment', 'dayforce', 'b6e2aba332dd', ARRAY['financialActions','dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('update_pay_adjustment', 'dayforce', '23a449a7ec8f', ARRAY['financialActions','dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_job_step_rates', 'dayforce', 'dc32e63e60f9', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_retro_pay', 'dayforce', '97b9354d91af', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('create_schedule', 'dayforce', '749b4059d15a', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('update_schedule', 'dayforce', 'b62cb52d8712', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_punches', 'dayforce', '503a9e82808d', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('create_punch', 'dayforce', 'e25a12302f79', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('update_punch', 'dayforce', '3e2206141b0c', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('delete_punch', 'dayforce', '19b250859682', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('submit_availability', 'dayforce', 'ff4aac44bef9', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_balance_periods', 'dayforce', '5d2de0ea0aa3', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_balance_transactions', 'dayforce', 'ee49e5b7c3fa', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('create_balance_transaction', 'dayforce', '2b3a5dd0dee0', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('update_balance_transaction', 'dayforce', '49c0de9bac17', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('get_orgunit', 'dayforce', '34021fb594ba', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('create_orgunit', 'dayforce', 'd4a986c1095e', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('update_orgunit', 'dayforce', '55230d0d0e3a', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_departments', 'dayforce', 'c0558d683668', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('get_department', 'dayforce', '77e1a9d1c485', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('get_job', 'dayforce', '40ae105c7020', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('create_job', 'dayforce', 'baa8bb234c34', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('update_job', 'dayforce', 'd9a507d0c69c', ARRAY['dataChanges']::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_positions', 'dayforce', 'ce4976423ccf', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('get_position', 'dayforce', '1a79706ca7b4', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_labor_metrics', 'dayforce', 'fd109035037f', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_projects', 'dayforce', 'a73f616a682b', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('list_documents', 'dayforce', '68aa1cd76ec5', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL),
  ('get_report', 'dayforce', '32f4c7e33e89', ARRAY[]::TEXT[], NULL, 'native-hris-runtime-v1', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      integration_type = EXCLUDED.integration_type,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      classified_at = NOW();
