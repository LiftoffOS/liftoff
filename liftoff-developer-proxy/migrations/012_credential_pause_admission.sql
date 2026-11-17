-- migrations/012_credential_pause_admission.sql
-- Reversible `paused` credential state for self-service pause/resume,
-- authenticated by the represented liftoff_sk_* key.

BEGIN;

ALTER TABLE developer_proxy_credentials
  ADD COLUMN paused_at TIMESTAMPTZ;

ALTER TABLE developer_proxy_credentials
  ADD CONSTRAINT chk_dp_credentials_status
  CHECK (status IN ('active', 'paused', 'revoked'));

COMMIT;
