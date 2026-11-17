-- migrations/005_audit_log_archive.sql
-- Gap 5 — pointer table for cold-storage archived partitions.

BEGIN;

CREATE TABLE IF NOT EXISTS billing_audit_log_archive (
  id                     BIGSERIAL PRIMARY KEY,
  partition_name         TEXT NOT NULL UNIQUE,
  row_count              BIGINT NOT NULL,
  gcs_object_uri         TEXT NOT NULL,
  archived_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hash_chain_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  legal_hold_until       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_billing_audit_archive_partition
  ON billing_audit_log_archive(partition_name);

GRANT SELECT ON billing_audit_log_archive TO billing_app, billing_readonly;
REVOKE INSERT, UPDATE, DELETE ON billing_audit_log_archive FROM billing_app, billing_readonly;

COMMIT;
