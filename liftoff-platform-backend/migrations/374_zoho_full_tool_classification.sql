-- Zoho suite tool classification — full curated tool sets (supersedes 372).
--
-- Numbered 374, not 373: 373_distill_artifacts.sql landed on main while this
-- was in flight and check-migration-collisions caught the duplicate prefix
-- before the migrate step, so this file has never been applied anywhere and
-- renaming it is safe. (Renaming an APPLIED migration would not be —
-- pgmigrations records filenames, so the old name stays marked run forever.)
--
-- Migration 372 seeded 23 tool names, curated from a Composio tool index that
-- turned out to be badly truncated: REST GET /v3/tools?toolkit_slug= returns
-- 200 OK with a SHORT set (6 of zoho's 57 tools, 0 of zoho_books' 265). The
-- overlay tooling now reads the union of that endpoint and the SDK's
-- getRawComposioTools, and @liftoffos/composio-overlays@0.2.13 carries curated
-- overlays for all SEVEN Zoho toolkits — 183 tools. 372 is left applied and
-- untouched (never edit an applied migration); this one fixes forward.
--
-- 183 tools collapse to 131 rows because tool_classification_cache is UNIQUE on
-- (tool_name, COALESCE(tenant_id,'__global__')) and the lookup
-- (ToolClassifier.getCachedClassification) matches on tool_name ALONE —
-- integration_type is provenance and is never filtered on. One row serves every
-- connector exposing a tool of that name, so list_contacts is seeded once even
-- though five Zoho toolkits expose it. Duplicating a name inside one INSERT is
-- a 21000 that rolls back the entire pending batch.
--
-- Where connectors disagreed on a name, the STRICTEST categories win — the
-- union, never the looser side. Two cases, both checked rather than assumed:
--   * create_item — zoho_books classified it financialActions, zoho_invoice and
--     zoho_inventory did not. Seeded with financialActions.
--   * create_event — microsoft_outlook_calendar already holds
--     ['dataChanges','externalPublishing'] from migration 082. Zoho CRM's
--     create_event alone would have written ['dataChanges'] and silently
--     dropped externalPublishing from Outlook's gate. Seeded with the union.
--
-- Without these rows every tool defaults fail-secure (write + sensitive +
-- destructive), firing HITL on every call.

INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  -- zoho (33)
  ('convert_lead', 'zoho', '5926ea19b6b7', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('create_contact', 'zoho', '2670077bc280', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('create_deal', 'zoho', '1af0de2985a7', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('create_event', 'zoho', 'c0349c8c0c5b', ARRAY['dataChanges', 'externalPublishing']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('create_lead', 'zoho', '296e96f765c5', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('create_note', 'zoho', 'd3a9872ef8cd', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('create_record', 'zoho', '06c8482ce87a', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('create_tag', 'zoho', '6c00875a5c17', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('delete_contact', 'zoho', '40e445ad41ea', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('delete_deal', 'zoho', 'b2a767f389f2', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_account', 'zoho', '3c56603a22df', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_contact', 'zoho', 'a60c7f060ff5', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_records', 'zoho', 'cc2a0a8ede31', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_task', 'zoho', 'd354ab3a17c1', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_accounts', 'zoho', '72ad8ec6eb98', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_calls', 'zoho', 'cc404c2a4ece', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_contacts', 'zoho', '748c0e1ad6eb', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_deals', 'zoho', '5012c70411a1', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_events', 'zoho', '7008a4c787c9', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_leads', 'zoho', '65ba39cbebba', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_modules', 'zoho', 'bf8337505c72', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_notes', 'zoho', '1de2234efceb', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_tasks', 'zoho', '62c971797ef1', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('search_accounts', 'zoho', '112f9474b064', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('search_contacts', 'zoho', 'd39cc57e3b15', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('search_deals', 'zoho', '6d3f0b68c100', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('search_leads', 'zoho', '545f8649eb52', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('search_records', 'zoho', '7b18a7c51409', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('update_account', 'zoho', 'c8515b438300', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('update_deal', 'zoho', 'ce6e0ec6fe09', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('update_event', 'zoho', 'df5180be681d', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('update_lead', 'zoho', 'a8b79a5ddb39', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('update_record', 'zoho', 'b6e4b8fd42f0', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  -- zoho_bigin (23)
  ('add_records', 'zoho_bigin', '740edc45f95c', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('add_tags_to_records', 'zoho_bigin', '050d4d9eddc4', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('create_notes', 'zoho_bigin', 'd25c42591371', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('create_tags', 'zoho_bigin', 'f432d11dec9f', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('delete_attachment', 'zoho_bigin', '716d816f615b', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('delete_note', 'zoho_bigin', 'e0ae120cd854', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('delete_records', 'zoho_bigin', 'b0077b021953', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('download_attachment', 'zoho_bigin', '5ee270857c06', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_attachments', 'zoho_bigin', '03b51f1a7d36', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_deleted_records', 'zoho_bigin', '25318706937b', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_fields', 'zoho_bigin', '35551be8eddb', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_modules', 'zoho_bigin', '91ad6448dc46', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_organization', 'zoho_bigin', '90959f71da1c', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_pipeline_records', 'zoho_bigin', 'ec1c2abd2e2f', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_record', 'zoho_bigin', 'cbca68d988aa', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_records_count', 'zoho_bigin', '8aa6a31d4afd', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_related_records', 'zoho_bigin', 'ae356a9aa729', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_users', 'zoho_bigin', '693b544987cd', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('update_note', 'zoho_bigin', 'd6ea27ffbc89', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('update_records', 'zoho_bigin', '5918a9454b9e', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('update_related_records', 'zoho_bigin', '7c69c2c77ff6', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('upload_attachment', 'zoho_bigin', 'a28145f21eae', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('upsert_records', 'zoho_bigin', '418ef1cbfc4f', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  -- zoho_invoice (24)
  ('create_credit_note', 'zoho_invoice', 'ec226cb4a63e', ARRAY['dataChanges', 'financialActions']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('create_customer_payment', 'zoho_invoice', '077c625a112f', ARRAY['dataChanges', 'financialActions']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('create_estimate', 'zoho_invoice', '2ad16868f94e', ARRAY['dataChanges', 'financialActions']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('create_invoice', 'zoho_invoice', '9bab475ac506', ARRAY['dataChanges', 'financialActions']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('create_item', 'zoho_invoice', 'fc9e4236e2ae', ARRAY['dataChanges', 'financialActions']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('delete_invoice', 'zoho_invoice', '3c266002b84c', ARRAY['dataChanges', 'financialActions']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('email_estimate', 'zoho_invoice', 'dcc0f4053076', ARRAY['customerCommunication']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('email_invoice', 'zoho_invoice', '160cd0440c70', ARRAY['customerCommunication', 'financialActions']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_expense', 'zoho_invoice', 'e30e2efc8457', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_invoice', 'zoho_invoice', '188815c435c3', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_item', 'zoho_invoice', 'a802e5055271', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_credit_notes', 'zoho_invoice', '36a3d3f9c20f', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_estimates', 'zoho_invoice', 'c75f9b863414', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_expenses', 'zoho_invoice', 'de456bdf271a', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_invoice_payments', 'zoho_invoice', 'ffd152ee2b41', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_invoices', 'zoho_invoice', 'eeb3c853be9b', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_items', 'zoho_invoice', '1cc42e86e1ec', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_organizations', 'zoho_invoice', '4468c8934bb8', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_payments', 'zoho_invoice', '70a9cd065193', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_recurring_invoices', 'zoho_invoice', 'c6fd5880000e', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_users', 'zoho_invoice', '43686df333bc', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('mark_invoice_as_sent', 'zoho_invoice', 'af347e75bf6d', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('mark_invoice_as_void', 'zoho_invoice', '8eafcb1e240f', ARRAY['dataChanges', 'financialActions']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('update_contact', 'zoho_invoice', '3e538e97c7cd', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  -- zoho_books (18)
  ('create_expense', 'zoho_books', '04ce1e24a098', ARRAY['dataChanges', 'financialActions']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('create_invoice_from_sales_order', 'zoho_books', '5308964ddcb8', ARRAY['dataChanges', 'financialActions']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('create_journal', 'zoho_books', '7313d6d09003', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_bill', 'zoho_books', 'eac60bfdc15b', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_credit_note', 'zoho_books', '46b653f93e4f', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_estimate', 'zoho_books', 'bb0f490a6b9b', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_purchase_order', 'zoho_books', '2c717d8f4efc', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_sales_order', 'zoho_books', '432e3e827a4e', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_bills', 'zoho_books', '2bbc62134ae6', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_customer_payments', 'zoho_books', 'd8ad7d3cdd1a', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_purchase_orders', 'zoho_books', '6a597d29e3d6', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_sales_orders', 'zoho_books', '111313e47279', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('update_bill', 'zoho_books', '6652bd9e7950', ARRAY['dataChanges', 'financialActions']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('update_estimate', 'zoho_books', '7fc0d7d5d964', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('update_invoice', 'zoho_books', '6e3240cbe859', ARRAY['dataChanges', 'financialActions']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('update_item', 'zoho_books', '1d8b93538e3e', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('update_sales_order', 'zoho_books', '5f246e9b940e', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('void_invoice', 'zoho_books', '950daed5036e', ARRAY['dataChanges', 'financialActions']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  -- zoho_desk (17)
  ('create_ticket', 'zoho_desk', '26d4df4fe1c7', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('download_ticket_attachment', 'zoho_desk', '7f39ad50b07a', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_agent', 'zoho_desk', 'b3db5ab5048c', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_department', 'zoho_desk', 'ba7fa302b1c7', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_ticket', 'zoho_desk', '4fe3051cb0a9', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_ticket_latest_thread', 'zoho_desk', 'a4f8a5886314', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_ticket_resolution', 'zoho_desk', '6043e1e2471d', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_ticket_thread', 'zoho_desk', 'a8273361f59c', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_agents', 'zoho_desk', 'f4f0a937fb25', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_contact_accounts', 'zoho_desk', '9e9718dbdde2', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_departments', 'zoho_desk', '100a9807d0bc', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_ticket_conversations', 'zoho_desk', '8cbb0c4ab497', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_tickets', 'zoho_desk', '509e2258ce41', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_views', 'zoho_desk', 'f9375d813b3b', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('search', 'zoho_desk', 'd47d6bbb26c0', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('update_ticket', 'zoho_desk', '5ab86fd22a05', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('upload_ticket_attachment', 'zoho_desk', 'fa4cd602186e', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  -- zoho_inventory (9)
  ('create_bill', 'zoho_inventory', 'b400d669a490', ARRAY['dataChanges', 'financialActions']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('create_package', 'zoho_inventory', '0dfa50bba0c8', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('create_purchase_order', 'zoho_inventory', '31530b4ffa8a', ARRAY['dataChanges', 'financialActions']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('create_sales_order', 'zoho_inventory', '4d4c0b14c91d', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('delete_item', 'zoho_inventory', '629713673021', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('delete_package', 'zoho_inventory', '263c045c8384', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('delete_sales_order', 'zoho_inventory', '73b0368aaf3c', ARRAY['dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_current_user', 'zoho_inventory', '8cbee7f6a506', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_item_groups', 'zoho_inventory', 'f337c9d32dda', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  -- zoho_mail (7)
  ('create_draft', 'zoho_mail', '6dcdd2cd099e', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('get_message_content', 'zoho_mail', '2123d9ad8f39', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_bookmarks', 'zoho_mail', 'db0869eeb817', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('list_emails', 'zoho_mail', 'b668af1e5495', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('reply_to_email', 'zoho_mail', '3bf3d7d9d705', ARRAY['customerCommunication', 'dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('search_messages', 'zoho_mail', '77cef220575d', ARRAY[]::TEXT[], NULL, 'classify-script-v1', false, NULL),
  ('send_email', 'zoho_mail', 'b226b66625b5', ARRAY['customerCommunication', 'dataChanges']::TEXT[], NULL, 'classify-script-v1', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      classified_at = NOW();
