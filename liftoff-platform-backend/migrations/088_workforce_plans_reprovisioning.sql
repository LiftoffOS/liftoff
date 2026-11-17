-- Workforce Plans: re-provisioning support
--
-- Adds two JSONB columns to `workforce_plans` so the HRBP Agent can diff
-- a re-approved (amended) plan against its previously-provisioned state:
--
--   last_provisioned_specs - array of { specId, internalAgentId } captured
--     at the end of every successful HRBP run. The HRBP loads this on the
--     next approve() to know which specs existed before, so it can detect:
--       - specs that survived (update / skip depending on field diff)
--       - specs that were removed (flag, no auto-delete)
--       - specs that are new (create)
--   removed_spec_ids - array of specIds that were in the previous run but
--     not in the current one. Populated by the HRBP during re-provisioning
--     diff. Exposed in the plan API so the UI can surface "these agents
--     no longer appear in the plan - delete them on /teams/update if you
--     want them gone".
--
-- Both default to empty so existing plans migrate cleanly.

ALTER TABLE workforce_plans
  ADD COLUMN IF NOT EXISTS last_provisioned_specs JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS removed_spec_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
