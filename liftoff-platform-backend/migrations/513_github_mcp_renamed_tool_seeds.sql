-- 513: seeds for the GitHub MCP server's renamed tools.
--
-- Migration 084 seeded GitHub's tools under the names the server published
-- then. The server has since renamed them: create_pull_request_review became
-- pull_request_review_write, create_issue and update_issue became issue_write,
-- and so on. The runtime reports each name it cannot find as
-- `vendor_mcp_tool_unseeded` and classifies it by verb, and the verb list
-- knows 'write' but not 'publishing': a review posted to a public pull request
-- loses its externalPublishing category once the name changes, so the
-- Communication setting's review gate stops applying to it (every unseeded
-- write-class name carries dataChanges alone).
--
-- Each row below mirrors the category set migration 084 gave the tool's
-- previous name; a name with no clear predecessor is left unseeded rather
-- than guessed at. Global rows (tenant_id IS NULL), idempotent, and no
-- effect_class: the classifier writes that on a discovery and a seed does not.
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  -- Reads
  ('issue_read', 'github', 'vendor_seed_v2', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('pull_request_read', 'github', 'vendor_seed_v2', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_issue_fields', 'github', 'vendor_seed_v2', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_issue_types', 'github', 'vendor_seed_v2', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_releases', 'github', 'vendor_seed_v2', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_repository_collaborators', 'github', 'vendor_seed_v2', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_tags', 'github', 'vendor_seed_v2', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_label', 'github', 'vendor_seed_v2', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_latest_release', 'github', 'vendor_seed_v2', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_release_by_tag', 'github', 'vendor_seed_v2', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_tag', 'github', 'vendor_seed_v2', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('search_commits', 'github', 'vendor_seed_v2', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('search_pull_requests', 'github', 'vendor_seed_v2', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('search_users', 'github', 'vendor_seed_v2', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  -- Writes that publish where people outside the workspace read
  ('pull_request_review_write', 'github', 'vendor_seed_v2', ARRAY['dataChanges', 'externalPublishing'], NULL, 'vendor-mcp-seed', false, NULL),
  ('add_reply_to_pull_request_comment', 'github', 'vendor_seed_v2', ARRAY['dataChanges', 'externalPublishing'], NULL, 'vendor-mcp-seed', false, NULL),
  ('update_issue_comment', 'github', 'vendor_seed_v2', ARRAY['dataChanges', 'externalPublishing'], NULL, 'vendor-mcp-seed', false, NULL),
  -- Writes
  ('issue_write', 'github', 'vendor_seed_v2', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  ('sub_issue_write', 'github', 'vendor_seed_v2', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  ('add_comment_to_pending_review', 'github', 'vendor_seed_v2', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  ('update_pull_request', 'github', 'vendor_seed_v2', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  ('update_pull_request_branch', 'github', 'vendor_seed_v2', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  ('create_repository', 'github', 'vendor_seed_v2', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  ('fork_repository', 'github', 'vendor_seed_v2', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  ('delete_file', 'github', 'vendor_seed_v2', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  ('request_copilot_review', 'github', 'vendor_seed_v2', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL)
ON CONFLICT (tool_name, COALESCE(integration_type, ''), COALESCE(tenant_id, '__global__')) DO NOTHING;
