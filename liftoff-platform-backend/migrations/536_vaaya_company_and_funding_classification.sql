-- Tool classification for the twenty-one private-company and venture-funding
-- reads the vaaya rung offers.
--
-- Two upstream suppliers, both reached by their own named actions rather than
-- a pinned path. Ten answer questions about a private company from the
-- outside -- its profile, who reviews it as an employer, what people say about
-- its products, how its headcount has moved, how its site is visited, what it
-- is hiring for, what it posts, and the news about it -- and eleven answer
-- questions about venture funding: the round, who raised it, from whom, and
-- every round a company, a firm or a person has been part of.
--
-- ALL TWENTY-ONE ANSWER. Each is mapped only after a live call returned real
-- data. That matters because the rung's catalog is not evidence: a supplier's
-- catalog can advertise many paths of which only a few return anything.
-- Nothing here is mapped on the strength of a catalog row alone.
--
-- Five of the twenty-one are cheap or free resolvers (a name to an identifier,
-- an industry or a place to the exact term a search accepts). They are here
-- because the detail calls take identifiers rather than names, so without them
-- the expensive calls cannot be reached at all.
--
-- Every one is a public-data read that changes nothing in the workspace's own
-- systems: a reviewed, category-less classification, as migrations 498, 502,
-- 503, 505, 526, 528 and 535 gave the other rungs. The hash is sha256 of the
-- function's registry description, first twelve hex characters.
--
-- Idempotent.

INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('private_company_resolve', 'vaaya', '636b898d151c', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('industry_taxonomy_resolve', 'vaaya', 'd0197bfe8750', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('private_company_profile', 'vaaya', '84a2b07e7dff', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('company_news', 'vaaya', 'd0e51299e0ac', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('employer_reviews', 'vaaya', '72adafa79496', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('product_reviews', 'vaaya', '5a421277e0a2', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('company_headcount_trends', 'vaaya', '03237164cd82', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('company_website_traffic', 'vaaya', '0446e03fea51', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('company_job_posts', 'vaaya', '089ae2720b3e', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('company_social_posts', 'vaaya', 'a7ad3d773c2e', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('venture_rounds_search', 'vaaya', 'ec32f1bfbdd6', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('venture_company_profile', 'vaaya', 'd8f5106e0bd4', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('company_funding_history', 'vaaya', '1661b0b90ece', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('funding_round_investors', 'vaaya', '88e7984cbafe', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('investor_deal_history', 'vaaya', 'e8ed5870ca4e', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('person_investment_history', 'vaaya', 'd1625d948f9f', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('venture_company_resolve', 'vaaya', '153b51f9ebd7', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('investor_resolve', 'vaaya', 'e7533264f77b', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('investor_person_resolve', 'vaaya', '5439c1864e89', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('venture_industry_resolve', 'vaaya', '2eaa07abfd0d', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL),
  ('venture_location_resolve', 'vaaya', 'fccf9215fd76', ARRAY[]::TEXT[], NULL, 'manual-aggregator-reads', true, NULL)
ON CONFLICT (tool_name, COALESCE(integration_type, ''), COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      is_manual_override = EXCLUDED.is_manual_override,
      classified_at = NOW();
