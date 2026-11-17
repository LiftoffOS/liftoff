-- migrations/005_idempotency_keys.sql
-- HRBP (workforce-service) sends Idempotency-Key
-- on InitiateOAuth / Execute / ExecuteBatch so a provisioning-run
-- resume after crash never double-provisions a connector or
-- double-executes an action.
--
-- Scoped by (tenant_id, rpc_name, key); separate rpc_name keeps the
-- cache row unique even if HRBP reuses the same key across different
-- RPC surfaces (unlikely, but defensive).

CREATE TABLE idempotency_keys (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key               TEXT NOT NULL,
  tenant_id         UUID NOT NULL,
  user_id           TEXT NULL,
  rpc_name          TEXT NOT NULL,   -- 'Execute' | 'ExecuteBatch' | 'POST /api/connectors/oauth/:type/start'
  endpoint          TEXT NOT NULL,   -- duplicate of rpc_name; kept for REST / Connect-RPC parity
  request_hash      TEXT NOT NULL,
  response_status   INTEGER,
  response_body     JSONB,
  response_headers  JSONB NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
  UNIQUE (tenant_id, key, rpc_name)
);

CREATE INDEX idx_connector_idempotency_expires
  ON idempotency_keys(expires_at);

CREATE INDEX idx_connector_idempotency_user
  ON idempotency_keys(user_id)
  WHERE user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION cleanup_expired_idempotency_keys()
RETURNS void AS $$
BEGIN
  DELETE FROM idempotency_keys WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;
