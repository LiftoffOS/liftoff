-- Tool classification for three more functions on the locus aggregator rung:
-- deep person and company profile enrichment and LinkedIn-to-contact details,
-- served through Locus's pass-throughs of the vendors' own APIs. Each reads a
-- third party's data and changes nothing in the workspace's own systems: a
-- reviewed, category-less classification, as migration 498 gave the rung's
-- first eight. Hashes are sha256 of each function's registry description,
-- first twelve hex characters; the manual-override mark means a later
-- description edit does not send the row back to the classifier. Idempotent.

INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('person_profile_enrich', 'locus', '6b98418922c8', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('company_profile_enrich', 'locus', '50f852e3beef', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('linkedin_contact_details', 'locus', '5e519309c9fe', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL)
ON CONFLICT (tool_name, COALESCE(integration_type, ''), COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      is_manual_override = EXCLUDED.is_manual_override,
      classified_at = NOW();
