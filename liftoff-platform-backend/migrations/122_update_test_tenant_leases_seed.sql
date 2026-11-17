-- Update test_tenant_leases to use YOUR_TENANT_PROJECT as the one available
-- CI test tenant.
--
-- Migration 121 seeds 5 placeholder IDs (tenant-ci-test-01..05-dev). Each needs
-- a real GCP project provisioned from the tenant-runtime-template terraform
-- (org folder, billing, Cloud SQL) before CI can lease it.
--
-- YOUR_TENANT_PROJECT is an existing tenant project. CI leases it for e2e runs
-- (serial), truncates data between runs, and releases it. The placeholder IDs
-- are marked available=FALSE until real projects exist.

-- Mark the original placeholder IDs as not yet provisioned
UPDATE test_tenant_leases
SET available = FALSE
WHERE test_tenant_id IN (
  'tenant-ci-test-01-dev',
  'tenant-ci-test-02-dev',
  'tenant-ci-test-03-dev',
  'tenant-ci-test-04-dev',
  'tenant-ci-test-05-dev'
);

-- Add the existing project as an available test tenant
INSERT INTO test_tenant_leases (test_tenant_id, available)
VALUES ('YOUR_TENANT_PROJECT', TRUE)
ON CONFLICT (test_tenant_id) DO UPDATE SET available = TRUE;
