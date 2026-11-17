-- Migration 084: Pre-seed tool classifications for vendor-hosted MCP connectors
-- Stripe, HubSpot, and GitHub tools are discovered dynamically but we already
-- know what they expose. Seeding avoids an LLM classification round-trip on
-- first agent interaction.
--
-- Tool names sourced from:
-- Stripe: https://docs.stripe.com/mcp (27 tools)
-- HubSpot: https://developers.hubspot.com/docs/mcp (12 tools, read-only)
-- GitHub: https://github.com/github/github-mcp-server (70+ tools, seeding key ones)

-- ═══════════════════════════════════════════════════════════════
-- Stripe (27 tools) — from mcp.stripe.com
-- ═══════════════════════════════════════════════════════════════
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  -- Read operations
  ('get_balance', 'stripe', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_balance_transaction', 'stripe', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_balance_transactions', 'stripe', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_charge', 'stripe', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_charges', 'stripe', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_customer', 'stripe', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_customers', 'stripe', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_invoice', 'stripe', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_invoices', 'stripe', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_payment_intent', 'stripe', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_payment_intents', 'stripe', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_price', 'stripe', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_prices', 'stripe', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_product', 'stripe', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_products', 'stripe', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_subscription', 'stripe', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_subscriptions', 'stripe', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_refund', 'stripe', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_refunds', 'stripe', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_disputes', 'stripe', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_payout', 'stripe', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_payouts', 'stripe', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  -- Write operations
  ('create_customer', 'stripe', 'vendor_seed_v1', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  ('create_invoice', 'stripe', 'vendor_seed_v1', ARRAY['financialActions', 'dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  ('create_product', 'stripe', 'vendor_seed_v1', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  ('create_price', 'stripe', 'vendor_seed_v1', ARRAY['financialActions', 'dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  ('create_refund', 'stripe', 'vendor_seed_v1', ARRAY['financialActions', 'dataChanges'], NULL, 'vendor-mcp-seed', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- HubSpot (12 tools) — from mcp.hubspot.com (all read-only)
-- ═══════════════════════════════════════════════════════════════
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('get_contact', 'hubspot', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_contacts', 'hubspot', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('search_contacts', 'hubspot', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_company', 'hubspot', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_companies', 'hubspot', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('search_companies', 'hubspot', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_deal', 'hubspot', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_deals', 'hubspot', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('search_deals', 'hubspot', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_ticket', 'hubspot', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_tickets', 'hubspot', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('search_tickets', 'hubspot', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- GitHub (key tools) — from api.github.com/mcp
-- Seeding the most commonly used tools. Any tools not seeded here
-- will be classified by the LLM on first discovery and cached.
-- ═══════════════════════════════════════════════════════════════
INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  -- Read operations
  ('get_repo', 'github', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_repos', 'github', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_issue', 'github', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_issues', 'github', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_pull_request', 'github', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_pull_requests', 'github', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_file_contents', 'github', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('search_code', 'github', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('search_issues', 'github', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('search_repositories', 'github', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_commits', 'github', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_commit', 'github', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_branches', 'github', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('list_pull_request_files', 'github', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_pull_request_diff', 'github', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  ('get_pull_request_reviews', 'github', 'vendor_seed_v1', ARRAY[]::TEXT[], NULL, 'vendor-mcp-seed', false, NULL),
  -- Write operations
  ('create_issue', 'github', 'vendor_seed_v1', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  ('update_issue', 'github', 'vendor_seed_v1', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  ('add_issue_comment', 'github', 'vendor_seed_v1', ARRAY['dataChanges', 'externalPublishing'], NULL, 'vendor-mcp-seed', false, NULL),
  ('create_pull_request', 'github', 'vendor_seed_v1', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  ('create_pull_request_review', 'github', 'vendor_seed_v1', ARRAY['dataChanges', 'externalPublishing'], NULL, 'vendor-mcp-seed', false, NULL),
  ('merge_pull_request', 'github', 'vendor_seed_v1', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  ('create_repo', 'github', 'vendor_seed_v1', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  ('create_branch', 'github', 'vendor_seed_v1', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  ('push_files', 'github', 'vendor_seed_v1', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  ('create_or_update_file', 'github', 'vendor_seed_v1', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  ('fork_repo', 'github', 'vendor_seed_v1', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  -- Destructive operations
  ('delete_issue_comment', 'github', 'vendor_seed_v1', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL),
  ('delete_repository', 'github', 'vendor_seed_v1', ARRAY['dataChanges'], NULL, 'vendor-mcp-seed', false, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO NOTHING;
