-- Tool classification for the two aggregator rungs (locus, vaaya): every
-- function connector-service serves for them reads a third party's data and
-- changes nothing in the workspace's own systems, so each row is a reviewed,
-- category-less classification. The capability executor fail-closes on a
-- missing row, and the automatic read-class fallback admits a candidate only
-- when its row is reviewed (capabilityIsAffirmativeRead), so without these the
-- rungs could be discovered but never run. Function names are the capability
-- (email_find, funding_rounds, sec_filings_search), not a vendor; the same
-- name under both integration types is two rows, one per integration type,
-- as the identity index of migration 458 requires. Hashes are sha256 of each
-- function's registry description, first twelve hex characters, the way
-- src/mcp/tool-classifier.ts computes them; the manual-override mark means a
-- later description edit does not send the row back to the classifier.
-- Idempotent.

INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('people_search', 'locus', 'f062bc81ee1e', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('people_enrich', 'locus', '08e6c84d5c4e', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('company_search', 'locus', '13c7d97cc31d', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('company_enrich', 'locus', '542ca87d54a4', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('company_job_postings', 'locus', '7061b0993ab5', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('email_find', 'locus', '36a5e810a8af', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('email_verify', 'locus', 'ac8ea9383c21', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('domain_emails', 'locus', '32e8e5e573dc', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('email_find', 'vaaya', '8661e2240766', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('email_verify', 'vaaya', '5802ad188cb7', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('domain_emails', 'vaaya', 'c48e68e9ded1', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('linkedin_email', 'vaaya', '90c5e7e53d59', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('person_from_email', 'vaaya', '4512d12686c0', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('funding_rounds', 'vaaya', '79cf2aa7964f', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('acquisitions', 'vaaya', 'fa4093ee94d6', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('hiring_signals', 'vaaya', '5b7bd535e186', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('executive_moves', 'vaaya', 'ae539fdaf3f0', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('sec_filings_search', 'vaaya', '6d5ee76bbf7a', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('sec_company_filings', 'vaaya', '7d3423006b3e', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('patent_search', 'vaaya', '7ef83d05df82', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('court_opinions_search', 'vaaya', '6467f55b2e30', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL)
ON CONFLICT (tool_name, COALESCE(integration_type, ''), COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      is_manual_override = EXCLUDED.is_manual_override,
      classified_at = NOW();
