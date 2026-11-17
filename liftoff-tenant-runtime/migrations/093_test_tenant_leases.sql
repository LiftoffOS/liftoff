-- test_tenant_leases
-- Pool-based e2e test tenant leasing. 5 test tenants are pre-provisioned via
-- Terraform in a nightly admin job; CI leases one at start and releases on
-- teardown (trap-safe). This avoids a per-PR Terraform apply (too slow, quota
-- constrained).

CREATE TABLE IF NOT EXISTS test_tenant_leases (
  test_tenant_id VARCHAR(64) PRIMARY KEY,
  leased_by VARCHAR(128),
  leased_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  available BOOLEAN NOT NULL DEFAULT TRUE
);

-- Seed pool (5 tenants matching the pre-provisioned Terraform output)
INSERT INTO test_tenant_leases (test_tenant_id, available) VALUES
  ('tenant-ci-test-01-dev', TRUE),
  ('tenant-ci-test-02-dev', TRUE),
  ('tenant-ci-test-03-dev', TRUE),
  ('tenant-ci-test-04-dev', TRUE),
  ('tenant-ci-test-05-dev', TRUE)
ON CONFLICT (test_tenant_id) DO NOTHING;

COMMENT ON TABLE test_tenant_leases IS
  'CI test tenant lease pool: CI leases an available test tenant and releases it on teardown.';
