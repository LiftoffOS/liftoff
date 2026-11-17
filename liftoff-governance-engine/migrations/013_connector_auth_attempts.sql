-- Migration 013: connector_auth_attempts for abuse detection.
--
-- src/admission/dynamic-quota-service.ts (maybeRunAbuseDetection) records
-- connector authentication attempts to detect credential enumeration attacks.
-- The table was missing; the query failure was caught and swallowed, so
-- abuse detection silently did nothing. This migration creates the table so
-- the detection path actually functions.
--
-- The query pattern is:
--   SELECT COUNT(*) FROM connector_auth_attempts
--   WHERE tenant_id = $1 AND success = false
--     AND attempted_at > NOW() - INTERVAL '5 minutes'

CREATE TABLE IF NOT EXISTS connector_auth_attempts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT        NOT NULL,
  connector_id    TEXT,                              -- NULL for attempts without a known connector
  success         BOOLEAN     NOT NULL,
  attempted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connector_auth_attempts_tenant_recent
  ON connector_auth_attempts (tenant_id, attempted_at DESC)
  WHERE success = false;

-- Cleanup function for expired rows (called from the polling scheduler).
CREATE OR REPLACE FUNCTION cleanup_expired_connector_auth_attempts()
RETURNS void AS $$
BEGIN
  -- Retain 7 days for audit purposes; abuse signals are short-window only.
  DELETE FROM connector_auth_attempts
  WHERE attempted_at < NOW() - INTERVAL '7 days';
END;
$$ LANGUAGE plpgsql;
