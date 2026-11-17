-- Migration 082: Pre-seed tool classifications for all known MCP connector tools
-- Per MCP Connector Migration Plan: since we own the in-house MCP wrappers,
-- we know exactly what tools they expose and can pre-classify them.
-- This avoids fail-secure defaults blocking tools unnecessarily.
--
-- Self-hosted connectors (19): seeded here with known categories.
-- Vendor-hosted connectors (Stripe, HubSpot, GitHub): NOT seeded — their tools
-- are discovered dynamically and classified by the LLM on first discovery.
-- All connectors use the same LLM classification pipeline. No special-casing.
--
-- Categories use SensitivityCategory values: customerCommunication, financialActions,
-- dataChanges, externalPublishing, hiringDecisions

-- ═══════════════════════════════════════════════════════════════
-- Google Mail (8 tools)
-- ═══════════════════════════════════════════════════════════════
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('send_email', 'google_mail', 'mcp_seed_v1', ARRAY['customerCommunication', 'externalPublishing'], 'create_draft', 'mcp-migration-seed', false, NULL),
  ('reply_email', 'google_mail', 'mcp_seed_v1', ARRAY['customerCommunication', 'externalPublishing'], 'create_draft', 'mcp-migration-seed', false, NULL),
  ('forward_email', 'google_mail', 'mcp_seed_v1', ARRAY['customerCommunication', 'externalPublishing'], 'create_draft', 'mcp-migration-seed', false, NULL),
  ('create_draft', 'google_mail', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('read_email', 'google_mail', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('search', 'google_mail', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_email', 'google_mail', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('list_labels', 'google_mail', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- Google Calendar (8 tools)
-- ═══════════════════════════════════════════════════════════════
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('read_event', 'google_calendar', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('read_calendar', 'google_calendar', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('create_event', 'google_calendar', 'mcp_seed_v1', ARRAY['dataChanges', 'externalPublishing'], NULL, 'mcp-migration-seed', false, NULL),
  ('create_calendar', 'google_calendar', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('update_event', 'google_calendar', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('update_calendar', 'google_calendar', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_event', 'google_calendar', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_calendar', 'google_calendar', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- Google Docs (6 tools)
-- ═══════════════════════════════════════════════════════════════
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('read_document', 'google_docs', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('read_content', 'google_docs', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('create_document', 'google_docs', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('create_content', 'google_docs', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('update_document', 'google_docs', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_content', 'google_docs', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- Google Drive (8 tools)
-- ═══════════════════════════════════════════════════════════════
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('read_file', 'google_drive', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('read_folder', 'google_drive', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('create_folder', 'google_drive', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('create_file', 'google_drive', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('create_permission', 'google_drive', 'mcp_seed_v1', ARRAY['dataChanges', 'externalPublishing'], NULL, 'mcp-migration-seed', false, NULL),
  ('update_file', 'google_drive', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_file', 'google_drive', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_folder', 'google_drive', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- Google Sheets (7 tools)
-- ═══════════════════════════════════════════════════════════════
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('read_spreadsheet', 'google_sheets', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('read_values', 'google_sheets', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('create_spreadsheet', 'google_sheets', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('create_sheet', 'google_sheets', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('create_values', 'google_sheets', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('update_values', 'google_sheets', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_sheet', 'google_sheets', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- Google Slides (6 tools)
-- ═══════════════════════════════════════════════════════════════
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('read_presentation', 'google_slides', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('create_presentation', 'google_slides', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('create_slide', 'google_slides', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('create_textbox', 'google_slides', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('update_presentation', 'google_slides', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_slide', 'google_slides', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- Slack (9 tools)
-- ═══════════════════════════════════════════════════════════════
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('read_message', 'slack', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('read_channel', 'slack', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('send_message', 'slack', 'mcp_seed_v1', ARRAY['externalPublishing'], 'schedule_message', 'mcp-migration-seed', false, NULL),
  ('schedule_message', 'slack', 'mcp_seed_v1', ARRAY['externalPublishing'], NULL, 'mcp-migration-seed', false, NULL),
  ('create_channel', 'slack', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('update_message', 'slack', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('update_channel', 'slack', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_message', 'slack', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_channel', 'slack', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- Salesforce (7 tools)
-- ═══════════════════════════════════════════════════════════════
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('read_record', 'salesforce', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('search_records', 'salesforce', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('create_account', 'salesforce', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('create_contact', 'salesforce', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('create_lead', 'salesforce', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('create_opportunity', 'salesforce', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_record', 'salesforce', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- Microsoft Outlook Mail (8 tools)
-- ═══════════════════════════════════════════════════════════════
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('read_message', 'microsoft_outlook_mail', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('read_mail_folder', 'microsoft_outlook_mail', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('send_email', 'microsoft_outlook_mail', 'mcp_seed_v1', ARRAY['customerCommunication', 'externalPublishing'], 'create_draft', 'mcp-migration-seed', false, NULL),
  ('create_draft', 'microsoft_outlook_mail', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('create_mail_folder', 'microsoft_outlook_mail', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('update_message', 'microsoft_outlook_mail', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_message', 'microsoft_outlook_mail', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_mail_folder', 'microsoft_outlook_mail', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- Microsoft Outlook Calendar (4 tools)
-- ═══════════════════════════════════════════════════════════════
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('read_event', 'microsoft_outlook_calendar', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('create_event', 'microsoft_outlook_calendar', 'mcp_seed_v1', ARRAY['dataChanges', 'externalPublishing'], NULL, 'mcp-migration-seed', false, NULL),
  ('update_event', 'microsoft_outlook_calendar', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_event', 'microsoft_outlook_calendar', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- Microsoft Teams (5 tools)
-- ═══════════════════════════════════════════════════════════════
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('read_channel', 'microsoft_teams', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('send_message', 'microsoft_teams', 'mcp_seed_v1', ARRAY['externalPublishing'], NULL, 'mcp-migration-seed', false, NULL),
  ('create_channel', 'microsoft_teams', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('update_message', 'microsoft_teams', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_channel', 'microsoft_teams', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- Microsoft To Do (6 tools)
-- ═══════════════════════════════════════════════════════════════
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('read_task', 'microsoft_todo', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('list_task_lists', 'microsoft_todo', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('create_task', 'microsoft_todo', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('create_task_list', 'microsoft_todo', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('update_task', 'microsoft_todo', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_task', 'microsoft_todo', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- Microsoft Contacts (4 tools)
-- ═══════════════════════════════════════════════════════════════
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('read_contact', 'microsoft_contacts', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('create_contact', 'microsoft_contacts', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('update_contact', 'microsoft_contacts', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_contact', 'microsoft_contacts', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- Microsoft OneNote (7 tools)
-- ═══════════════════════════════════════════════════════════════
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('read_notebook', 'microsoft_onenote', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('read_page', 'microsoft_onenote', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('create_notebook', 'microsoft_onenote', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('create_section', 'microsoft_onenote', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('create_page', 'microsoft_onenote', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('update_page', 'microsoft_onenote', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_page', 'microsoft_onenote', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- Microsoft SharePoint (6 tools)
-- ═══════════════════════════════════════════════════════════════
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('read_site', 'microsoft_sharepoint', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('read_list_item', 'microsoft_sharepoint', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('create_list', 'microsoft_sharepoint', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('create_list_item', 'microsoft_sharepoint', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('update_list_item', 'microsoft_sharepoint', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_list_item', 'microsoft_sharepoint', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- Microsoft Planner (6 tools)
-- ═══════════════════════════════════════════════════════════════
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('read_task', 'microsoft_planner', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('list_tasks', 'microsoft_planner', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('create_task', 'microsoft_planner', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('create_bucket', 'microsoft_planner', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('update_task', 'microsoft_planner', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_task', 'microsoft_planner', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- Microsoft OneDrive (6 tools)
-- ═══════════════════════════════════════════════════════════════
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('read_file', 'microsoft_onedrive', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('read_folder', 'microsoft_onedrive', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('create_folder', 'microsoft_onedrive', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('update_file', 'microsoft_onedrive', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_file', 'microsoft_onedrive', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_folder', 'microsoft_onedrive', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- Dropbox (6 tools)
-- ═══════════════════════════════════════════════════════════════
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('read_file', 'dropbox', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('read_folder', 'dropbox', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('create_folder', 'dropbox', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('update_file', 'dropbox', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_file', 'dropbox', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_folder', 'dropbox', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- Box (6 tools)
-- ═══════════════════════════════════════════════════════════════
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('read_file', 'box', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('read_folder', 'box', 'mcp_seed_v1', ARRAY[]::TEXT[], NULL, 'mcp-migration-seed', false, NULL),
  ('create_folder', 'box', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('update_file', 'box', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_file', 'box', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL),
  ('delete_folder', 'box', 'mcp_seed_v1', ARRAY['dataChanges'], NULL, 'mcp-migration-seed', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- Vendor-hosted MCP servers (Stripe, HubSpot, GitHub)
-- NOT seeded — tools are discovered dynamically and classified
-- by the LLM on first discovery, then cached. Same pipeline as
-- every other connector.
-- ═══════════════════════════════════════════════════════════════
