-- Tool classification for Saperly's NATIVE REST tools (the new ones).
--
-- Saperly moved from the MCP executor to a native REST executor over
-- api.saperly.com (connector-service src/clients/saperly.ts), whose surface is
-- the complete one. The tools it shares with the MCP set stay classified by
-- migration 455; this migration classifies the tools the REST surface ADDS and
-- the MCP subset lacked — the TCPA consent tools, call transcript/recording,
-- pricing quote, language/voice lists, and end-call. The MCP-only rows from 455
-- that the REST set drops (search_available_numbers, sync_connection,
-- speak_into_call) stay as dead, harmless rows.
--
-- executeVendorTool fail-closes on the platform capability surface for anything
-- whose categories fall in the blocked set (write, destructive, outbound,
-- financialActions, customerCommunication), so:
--   * reads (transcript, recording, quote, language/voice lists, consent
--     check/list) carry NO category and run;
--   * recording/revoking consent is a write;
--   * ending a live call is a write (a control change on an in-flight call, not
--     a new outbound contact).
-- Classification is keyed on tool_name alone; ON CONFLICT re-asserts categories.

INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  -- reads
  ('get_call_transcript', 'saperly', 'saprest0001', ARRAY[]::TEXT[], NULL, 'native-saperly-rest', true, NULL),
  ('get_call_recording', 'saperly', 'saprest0002', ARRAY[]::TEXT[], NULL, 'native-saperly-rest', true, NULL),
  ('price_quote', 'saperly', 'saprest0003', ARRAY[]::TEXT[], NULL, 'native-saperly-rest', true, NULL),
  ('list_languages', 'saperly', 'saprest0004', ARRAY[]::TEXT[], NULL, 'native-saperly-rest', true, NULL),
  ('list_voices', 'saperly', 'saprest0005', ARRAY[]::TEXT[], NULL, 'native-saperly-rest', true, NULL),
  ('check_consent', 'saperly', 'saprest0006', ARRAY[]::TEXT[], NULL, 'native-saperly-rest', true, NULL),
  ('list_consent', 'saperly', 'saprest0007', ARRAY[]::TEXT[], NULL, 'native-saperly-rest', true, NULL),
  -- consent writes + call control write
  ('record_consent', 'saperly', 'saprest0008', ARRAY['write']::TEXT[], NULL, 'native-saperly-rest', true, NULL),
  ('revoke_consent', 'saperly', 'saprest0009', ARRAY['write']::TEXT[], NULL, 'native-saperly-rest', true, NULL),
  ('end_call', 'saperly', 'saprest000a', ARRAY['write']::TEXT[], NULL, 'native-saperly-rest', true, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      integration_type = EXCLUDED.integration_type,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      classified_at = NOW();
