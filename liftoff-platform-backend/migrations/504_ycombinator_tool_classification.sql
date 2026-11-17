-- Tool classification for the two functions on the ycombinator card: a
-- keyless read of Y Combinator's public company directory (search, and one
-- company's profile). Each reads public data and changes nothing in the
-- workspace's own systems: a reviewed, category-less classification, as
-- migration 436 gave nasdaq's reads. Hashes are sha256 of each function's
-- registry description, first twelve hex characters; the manual-override
-- mark means a later description edit does not send the row back to the
-- classifier. Idempotent.

INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('yc_companies_search', 'ycombinator', '17d9aacdd49a', ARRAY[]::TEXT[], NULL, 'manual-public-data-reads', true, NULL),
  ('yc_company_profile', 'ycombinator', '0c022857b07f', ARRAY[]::TEXT[], NULL, 'manual-public-data-reads', true, NULL)
ON CONFLICT (tool_name, COALESCE(integration_type, ''), COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      is_manual_override = EXCLUDED.is_manual_override,
      classified_at = NOW();
