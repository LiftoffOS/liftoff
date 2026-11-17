-- Mesh (mesh, mcp.clay.earth) tool classification seeds — 20 tools enumerated live via tools/list (2026-06-23)
-- Conservative, rules-based: read/get/search -> []; create/update/archive/restore/note/group/merge -> ['dataChanges']
INSERT INTO tool_classification_cache
  (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('get_user_information', 'mesh', 'd9c344d8b044', ARRAY[]::TEXT[], NULL, 'manual-mesh-rules-v1', false, NULL),
  ('searchContacts', 'mesh', 'c4d46c16cf75', ARRAY[]::TEXT[], NULL, 'manual-mesh-rules-v1', false, NULL),
  ('getContact', 'mesh', 'bb5c5d7a01d1', ARRAY[]::TEXT[], NULL, 'manual-mesh-rules-v1', false, NULL),
  ('createContact', 'mesh', 'f71eac260e4f', ARRAY['dataChanges']::TEXT[], NULL, 'manual-mesh-rules-v1', false, NULL),
  ('updateContact', 'mesh', '81c5b6c616e3', ARRAY['dataChanges']::TEXT[], NULL, 'manual-mesh-rules-v1', false, NULL),
  ('archive_contact', 'mesh', '467ee8e69324', ARRAY['dataChanges']::TEXT[], NULL, 'manual-mesh-rules-v1', false, NULL),
  ('restore_contact', 'mesh', '0141e0b1eef0', ARRAY['dataChanges']::TEXT[], NULL, 'manual-mesh-rules-v1', false, NULL),
  ('createNote', 'mesh', 'b5577a5c3005', ARRAY['dataChanges']::TEXT[], NULL, 'manual-mesh-rules-v1', false, NULL),
  ('getGroups', 'mesh', '807ce3e11fe7', ARRAY[]::TEXT[], NULL, 'manual-mesh-rules-v1', false, NULL),
  ('createGroup', 'mesh', 'b0b7cff0eec9', ARRAY['dataChanges']::TEXT[], NULL, 'manual-mesh-rules-v1', false, NULL),
  ('updateGroup', 'mesh', '14750e01471d', ARRAY['dataChanges']::TEXT[], NULL, 'manual-mesh-rules-v1', false, NULL),
  ('getNotes', 'mesh', '2410bf03c323', ARRAY[]::TEXT[], NULL, 'manual-mesh-rules-v1', false, NULL),
  ('getEvents', 'mesh', 'd7b46569d69e', ARRAY[]::TEXT[], NULL, 'manual-mesh-rules-v1', false, NULL),
  ('getUpcomingEvents', 'mesh', 'b818be9c2c26', ARRAY[]::TEXT[], NULL, 'manual-mesh-rules-v1', false, NULL),
  ('getEmails', 'mesh', '11d00af81404', ARRAY[]::TEXT[], NULL, 'manual-mesh-rules-v1', false, NULL),
  ('getRecentEmails', 'mesh', '5bd729da08e0', ARRAY[]::TEXT[], NULL, 'manual-mesh-rules-v1', false, NULL),
  ('getRecentReminders', 'mesh', '9222521e4463', ARRAY[]::TEXT[], NULL, 'manual-mesh-rules-v1', false, NULL),
  ('getUpcomingReminders', 'mesh', '9222521e4463', ARRAY[]::TEXT[], NULL, 'manual-mesh-rules-v1', false, NULL),
  ('find_duplicates', 'mesh', '5a486aed17f0', ARRAY[]::TEXT[], NULL, 'manual-mesh-rules-v1', false, NULL),
  ('merge_contacts', 'mesh', '956efc616cb8', ARRAY['dataChanges']::TEXT[], NULL, 'manual-mesh-rules-v1', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      classified_at = NOW();
