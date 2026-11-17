-- Tool classification for the one platform-funded Apify actor-run capability.
--
-- `apify:run_actor` is how a distilled agent (and the Liftoff assistant) runs a
-- public Apify Store actor on the platform account, through the single guarded
-- executor (capability-discovery/vendor-execution.executeVendorTool). That
-- executor fail-closes on a missing classification, so without this row every
-- platform-funded scrape refuses.
--
-- ONE row for the whole call-actor class (classification is keyed on tool_name
-- alone). Running a public web-extraction actor is a READ: it observes public
-- pages and returns a dataset, changing nothing in the workspace's own systems,
-- so the category array is empty and it is not HITL-gated. A specific actor that
-- writes somewhere is not reachable through this capability — it only ever reads
-- a dataset back.

INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, reviewed_by, is_manual_override, tenant_id)
VALUES
  ('run_actor', 'apify', 'a1f7c0de9b21', ARRAY[]::TEXT[], NULL, 'manual-apify-run-actor', true, NULL)
ON CONFLICT (tool_name, COALESCE(tenant_id, '__global__')) DO UPDATE
  SET categories = EXCLUDED.categories,
      tool_description_hash = EXCLUDED.tool_description_hash,
      reviewed_by = EXCLUDED.reviewed_by,
      classified_at = NOW();
