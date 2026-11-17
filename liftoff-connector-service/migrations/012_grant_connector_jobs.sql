-- Migration 012: Grant connector_admin access to connector_jobs.
--
-- Migration 006 granted connector_admin on tables from migrations 001-005.
-- Migration 011 added connector_jobs but was never covered by a grants migration.
--
-- createJob() calls withAdminScope (→ connector_admin role, BYPASSRLS) to
-- INSERT job rows. Without this grant every create-from-template and
-- copy-and-replace call fails immediately with PostgreSQL 42501 (aclcheck_error)
-- before a Cloud Task is ever enqueued.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE connector_jobs TO connector_admin;
