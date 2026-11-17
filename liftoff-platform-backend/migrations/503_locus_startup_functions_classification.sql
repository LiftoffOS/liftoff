-- Tool classification for five more functions on the locus aggregator rung:
-- startup and company search and profiles, funding rounds, the people at a
-- company, and investor search, served through Locus's Parse endpoints at a
-- fixed charge. Each reads a third party's data and changes nothing in the
-- workspace's own systems: a reviewed, category-less classification, as
-- migrations 498 and 502 gave the rung's earlier functions. Hashes are sha256
-- of each function's registry description, first twelve hex characters; the
-- manual-override mark means a later description edit does not send the row
-- back to the classifier. Idempotent.

INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('startup_search', 'locus', 'e0b147ec6c42', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('startup_profile', 'locus', 'f50c1b6bc3a6', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('startup_funding_rounds', 'locus', 'ed7706f3075c', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('startup_people', 'locus', '307e16add13c', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('investor_search', 'locus', '0fb37dcf8e1a', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL)
ON CONFLICT (tool_name, COALESCE(integration_type, ''), COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      is_manual_override = EXCLUDED.is_manual_override,
      classified_at = NOW();
