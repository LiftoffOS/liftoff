-- Payload Archival Tables
-- Per Section 11: Raw payload archived in Cloud Storage

CREATE TABLE IF NOT EXISTS archived_payloads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(255) NOT NULL,
  connector_id VARCHAR(255) NOT NULL,
  payload_type VARCHAR(50) NOT NULL, -- webhook, api_response, poll_result, writeback
  gcs_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  checksum VARCHAR(64) NOT NULL, -- SHA-256 hash
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_archived_payloads_tenant_connector
  ON archived_payloads(tenant_id, connector_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_archived_payloads_expires
  ON archived_payloads(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_archived_payloads_type
  ON archived_payloads(tenant_id, payload_type, created_at DESC);

-- Cleanup function for expired payloads
-- Note: Actual GCS deletion should be handled by the application
CREATE OR REPLACE FUNCTION mark_expired_payloads()
RETURNS TABLE(id UUID, gcs_path TEXT) AS $$
BEGIN
  RETURN QUERY
  SELECT ap.id, ap.gcs_path
  FROM archived_payloads ap
  WHERE ap.expires_at < NOW();
END;
$$ LANGUAGE plpgsql;
