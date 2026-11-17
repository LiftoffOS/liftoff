-- Migration 003: re-provisioning snapshot columns
--
-- Adds last_provisioned_specs and removed_spec_ids to workforce_plans so the
-- HRBP Agent can diff specs across re-provisioning runs without a separate
-- history table. Adapted from platform-backend migration 088.

ALTER TABLE workforce_plans
  ADD COLUMN IF NOT EXISTS last_provisioned_specs JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS removed_spec_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
