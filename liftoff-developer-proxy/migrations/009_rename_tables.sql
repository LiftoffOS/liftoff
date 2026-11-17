BEGIN;

-- Rename byok tables to developer_proxy tables (service rename: byok-proxy → developer-proxy)

ALTER TABLE IF EXISTS byok_credentials       RENAME TO developer_proxy_credentials;
ALTER TABLE IF EXISTS byok_usage_log         RENAME TO developer_proxy_usage_log;
ALTER TABLE IF EXISTS byok_revocation_cache  RENAME TO developer_proxy_revocation_cache;
ALTER TABLE IF EXISTS byok_vendor_config     RENAME TO developer_proxy_vendor_config;
ALTER TABLE IF EXISTS byok_rate_limit_buckets RENAME TO developer_proxy_rate_limit_buckets;

-- Rename indexes on developer_proxy_credentials
ALTER INDEX IF EXISTS idx_byok_credentials_key_hash RENAME TO idx_developer_proxy_credentials_key_hash;
ALTER INDEX IF EXISTS idx_byok_credentials_tenant   RENAME TO idx_developer_proxy_credentials_tenant;
ALTER INDEX IF EXISTS idx_byok_credentials_active   RENAME TO idx_developer_proxy_credentials_active;

-- Rename indexes on developer_proxy_usage_log
ALTER INDEX IF EXISTS idx_byok_usage_log_request_id RENAME TO idx_developer_proxy_usage_log_request_id;
ALTER INDEX IF EXISTS idx_byok_usage_log_tenant      RENAME TO idx_developer_proxy_usage_log_tenant;
ALTER INDEX IF EXISTS idx_byok_usage_log_pending     RENAME TO idx_developer_proxy_usage_log_pending;
ALTER INDEX IF EXISTS idx_byok_usage_log_cred        RENAME TO idx_developer_proxy_usage_log_cred;

-- Rename index on developer_proxy_revocation_cache
ALTER INDEX IF EXISTS idx_byok_revocation_expires RENAME TO idx_developer_proxy_revocation_expires;

-- Rename index on developer_proxy_usage_log (agent attribution, migration 007)
ALTER INDEX IF EXISTS idx_byok_usage_agent RENAME TO idx_developer_proxy_usage_agent;

COMMIT;
