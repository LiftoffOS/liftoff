-- Migration 305: Pre-seed tool classifications for the GitLab vendor-hosted MCP.
-- GitLab is a vendor_hosted MCP (gitlab.com/api/v4/mcp); its tools are discovered
-- dynamically at agent runtime, but we already know the full inventory, so seeding
-- avoids an LLM classification round-trip on first agent interaction (same rationale
-- as migration 084 for GitHub/Stripe/HubSpot).
--
-- Tool names + read/write nature sourced from GitLab's official MCP tool reference:
--   https://docs.gitlab.com/user/model_context_protocol/mcp_server_tools/  (21 tools)
--
-- Categories mirror the sibling GitHub seed in migration 084 for analogous tools:
--   a posted note/comment carries externalPublishing (visible to collaborators),
--   every other state change carries dataChanges. Reads have no categories.
--
-- The classification cache is keyed globally by (tool_name, tenant_id) — see the
-- unique index in migration 081 — so tool names GitLab shares with GitHub
-- (get_issue, create_issue) already resolve to the identical GitHub-seeded
-- classification; the rows below are ON CONFLICT DO NOTHING and are kept for a
-- complete, self-documenting GitLab inventory.

-- ═══════════════════════════════════════════════════════════════
-- GitLab (21 tools) — from gitlab.com/api/v4/mcp
-- ═══════════════════════════════════════════════════════════════
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  -- Read operations
  ('get_mcp_server_version', 'gitlab', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_issue', 'gitlab', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_merge_request', 'gitlab', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_merge_request_commits', 'gitlab', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_merge_request_diffs', 'gitlab', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_merge_request_pipelines', 'gitlab', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_merge_request_notes', 'gitlab', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_pipeline_jobs', 'gitlab', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_job_log', 'gitlab', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_workitem_notes', 'gitlab', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_saved_view_work_items', 'gitlab', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('search', 'gitlab', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('search_labels', 'gitlab', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('semantic_code_search', 'gitlab', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  -- Write operations
  ('create_issue', 'gitlab', 'vendor_seed_v1', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  ('create_merge_request', 'gitlab', 'vendor_seed_v1', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  ('create_merge_request_note', 'gitlab', 'vendor_seed_v1', ARRAY['dataChanges', 'externalPublishing'], NULL, 'vendor-mcp-seed', false, NULL),
  ('create_workitem_note', 'gitlab', 'vendor_seed_v1', ARRAY['dataChanges', 'externalPublishing'], NULL, 'vendor-mcp-seed', false, NULL),
  ('link_work_items', 'gitlab', 'vendor_seed_v1', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  ('manage_pipeline', 'gitlab', 'vendor_seed_v1', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  ('attach_scan_profile', 'gitlab', 'vendor_seed_v1', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO NOTHING;
