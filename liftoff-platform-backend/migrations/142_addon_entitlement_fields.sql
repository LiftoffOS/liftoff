-- Entitlement flag columns for the add-on catalog.
--
-- Migration 040 added sso_enabled and priority_support_enabled to the entitlements
-- table. Three add-ons in the Phase 4 catalog require separate fields that are
-- not present in migration 040: audit_log_export, scim_enabled, advanced_reporting.
--
-- Note: the plan originally targeted the tenants table, but the canonical add-on
-- entitlement state lives in the entitlements table (one-to-one with tenants).

ALTER TABLE entitlements
  ADD COLUMN IF NOT EXISTS audit_log_export   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS scim_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS advanced_reporting BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN entitlements.audit_log_export   IS 'Paid add-on: Audit Log Export (S3/GCS)';
COMMENT ON COLUMN entitlements.scim_enabled       IS 'Paid add-on: SCIM Provisioning (IdP auto-provision)';
COMMENT ON COLUMN entitlements.advanced_reporting IS 'Paid add-on: Advanced Reporting (custom cost exports)';
