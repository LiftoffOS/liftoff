-- Tool classification for Saperly's NATIVE MCP tools.
--
-- Saperly moved from a composio_managed connector to a native MCP executor
-- (connector-service src/clients/saperly-mcp.ts) over api.saperly.com/mcp. The
-- native tool names — enumerated live from tools/list — differ
-- from the composio overlay names seeded in migration 453 (which stay as dead,
-- harmless rows). The executor fail-closes on the platform capability surface
-- for anything whose categories fall in the blocked set (write, destructive,
-- outbound, financialActions, customerCommunication), so:
--   * reads (list/get/search/usage) carry NO category and run;
--   * number provisioning is a financial action;
--   * releasing a number and deleting a connection are destructive;
--   * every connection/number configuration change is a write;
--   * every outbound call or SMS reaches a real person and costs money —
--     outbound + customerCommunication — so it never runs without approval.
-- classification is keyed on tool_name alone; ON CONFLICT re-asserts categories.

INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  -- reads
  ('list_numbers', 'saperly', 'sap0a1b2c3d0', ARRAY[]::TEXT[], NULL, 'native-saperly-mcp', true, NULL),
  ('get_number', 'saperly', 'sap0a1b2c3d1', ARRAY[]::TEXT[], NULL, 'native-saperly-mcp', true, NULL),
  ('search_available_numbers', 'saperly', 'sap0a1b2c3d2', ARRAY[]::TEXT[], NULL, 'native-saperly-mcp', true, NULL),
  ('list_connections', 'saperly', 'sap0a1b2c3d3', ARRAY[]::TEXT[], NULL, 'native-saperly-mcp', true, NULL),
  ('get_connection', 'saperly', 'sap0a1b2c3d4', ARRAY[]::TEXT[], NULL, 'native-saperly-mcp', true, NULL),
  ('get_call', 'saperly', 'sap0a1b2c3d5', ARRAY[]::TEXT[], NULL, 'native-saperly-mcp', true, NULL),
  ('list_calls', 'saperly', 'sap0a1b2c3d6', ARRAY[]::TEXT[], NULL, 'native-saperly-mcp', true, NULL),
  ('list_messages', 'saperly', 'sap0a1b2c3d7', ARRAY[]::TEXT[], NULL, 'native-saperly-mcp', true, NULL),
  ('get_usage', 'saperly', 'sap0a1b2c3d8', ARRAY[]::TEXT[], NULL, 'native-saperly-mcp', true, NULL),
  -- provisioning (financial) + destructive
  ('provision_number', 'saperly', 'sap0a1b2c3d9', ARRAY['financialActions']::TEXT[], NULL, 'native-saperly-mcp', true, NULL),
  ('release_number', 'saperly', 'sap0a1b2c3da', ARRAY['destructive']::TEXT[], NULL, 'native-saperly-mcp', true, NULL),
  ('delete_connection', 'saperly', 'sap0a1b2c3db', ARRAY['destructive']::TEXT[], NULL, 'native-saperly-mcp', true, NULL),
  -- configuration writes
  ('assign_number_connection', 'saperly', 'sap0a1b2c3dc', ARRAY['write']::TEXT[], NULL, 'native-saperly-mcp', true, NULL),
  ('set_sms_sender', 'saperly', 'sap0a1b2c3dd', ARRAY['write']::TEXT[], NULL, 'native-saperly-mcp', true, NULL),
  ('set_caller_id_name', 'saperly', 'sap0a1b2c3de', ARRAY['write']::TEXT[], NULL, 'native-saperly-mcp', true, NULL),
  ('create_connection', 'saperly', 'sap0a1b2c3df', ARRAY['write']::TEXT[], NULL, 'native-saperly-mcp', true, NULL),
  ('update_connection', 'saperly', 'sap0a1b2c3e0', ARRAY['write']::TEXT[], NULL, 'native-saperly-mcp', true, NULL),
  ('sync_connection', 'saperly', 'sap0a1b2c3e1', ARRAY['write']::TEXT[], NULL, 'native-saperly-mcp', true, NULL),
  -- outbound communication (reaches a real person, costs money)
  ('place_call', 'saperly', 'sap0a1b2c3e2', ARRAY['outbound','customerCommunication','financialActions']::TEXT[], NULL, 'native-saperly-mcp', true, NULL),
  ('send_sms', 'saperly', 'sap0a1b2c3e3', ARRAY['outbound','customerCommunication','financialActions']::TEXT[], NULL, 'native-saperly-mcp', true, NULL),
  ('transfer_call', 'saperly', 'sap0a1b2c3e4', ARRAY['outbound','customerCommunication']::TEXT[], NULL, 'native-saperly-mcp', true, NULL),
  ('speak_into_call', 'saperly', 'sap0a1b2c3e5', ARRAY['outbound','customerCommunication']::TEXT[], NULL, 'native-saperly-mcp', true, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      integration_type = EXCLUDED.integration_type,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      classified_at = NOW();
