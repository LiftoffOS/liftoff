-- test_tenant_leases: pool for CI e2e tenant leasing.
-- Shared PB DB is the lease arbiter; each CI run leases one pre-provisioned
-- tenant project, runs e2e, then releases.

CREATE TABLE IF NOT EXISTS test_tenant_leases (
  test_tenant_id VARCHAR(64) PRIMARY KEY,
  leased_by VARCHAR(128),
  leased_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  available BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO test_tenant_leases (test_tenant_id, available) VALUES
  ('tenant-ci-test-01-dev', TRUE),
  ('tenant-ci-test-02-dev', TRUE),
  ('tenant-ci-test-03-dev', TRUE),
  ('tenant-ci-test-04-dev', TRUE),
  ('tenant-ci-test-05-dev', TRUE)
ON CONFLICT (test_tenant_id) DO NOTHING;

COMMENT ON TABLE test_tenant_leases IS
  'CI e2e tenant lease pool. Each CI run leases one pre-provisioned tenant project, runs e2e, then releases it.';
