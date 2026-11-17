-- Connector Management Schema
-- Per Section 11 & 12: Connector management and health monitoring

-- Connectors table - stores connector instances per tenant
CREATE TABLE connectors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    type VARCHAR(50) NOT NULL,  -- 'google_drive', 'google_docs', 'google_sheets', 'google_slides', etc.
    name VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',  -- 'pending', 'active', 'error', 'disabled'
    config JSONB NOT NULL DEFAULT '{}',
    last_sync_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Connector credentials metadata (actual secrets in Secret Manager)
CREATE TABLE connector_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    credential_type VARCHAR(50) NOT NULL DEFAULT 'oauth2',  -- 'oauth2', 'api_key', 'service_account'
    secret_name VARCHAR(255) NOT NULL,  -- Reference to Secret Manager
    scopes JSONB,
    expires_at TIMESTAMP WITH TIME ZONE,
    last_refreshed_at TIMESTAMP WITH TIME ZONE,
    status VARCHAR(50) NOT NULL DEFAULT 'active',  -- 'active', 'expired', 'revoked', 'refreshing'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(connector_id)
);

-- Connector sync statistics
CREATE TABLE connector_sync_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    last_sync_at TIMESTAMP WITH TIME ZONE,
    last_sync_status VARCHAR(50),  -- 'success', 'partial', 'failed'
    last_sync_duration INTEGER,  -- milliseconds
    last_error TEXT,
    last_error_at TIMESTAMP WITH TIME ZONE,
    total_items_synced INTEGER NOT NULL DEFAULT 0,
    total_errors INTEGER NOT NULL DEFAULT 0,
    total_syncs INTEGER NOT NULL DEFAULT 0,
    average_sync_duration INTEGER,
    syncs_24h INTEGER NOT NULL DEFAULT 0,
    errors_24h INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(connector_id)
);

-- OAuth state for CSRF protection during OAuth flow
CREATE TABLE connector_oauth_states (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    state VARCHAR(255) UNIQUE NOT NULL,
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    account_id UUID NOT NULL REFERENCES accounts(id),
    connector_type VARCHAR(50) NOT NULL,
    scopes JSONB,
    redirect_uri VARCHAR(512),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Connector health metrics (time-series)
CREATE TABLE connector_health_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    metric_type VARCHAR(50) NOT NULL,  -- 'sync_duration', 'records_synced', 'errors', 'api_calls', 'rate_limit_hits'
    value NUMERIC NOT NULL,
    metadata JSONB,
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Connector incidents
CREATE TABLE connector_incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    severity VARCHAR(50) NOT NULL DEFAULT 'medium',  -- 'critical', 'high', 'medium', 'low'
    status VARCHAR(50) NOT NULL DEFAULT 'active',  -- 'active', 'investigating', 'resolved', 'acknowledged'
    error_code VARCHAR(100),
    error_message TEXT,
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    first_occurred_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_occurred_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    resolved_at TIMESTAMP WITH TIME ZONE,
    resolved_by VARCHAR(255),
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Connector health alerts
CREATE TABLE connector_health_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    alert_type VARCHAR(50) NOT NULL,  -- 'high_error_rate', 'sync_failure', 'credential_expiring', 'quota_exhausted'
    severity VARCHAR(50) NOT NULL DEFAULT 'medium',
    threshold NUMERIC,
    current_value NUMERIC,
    message TEXT,
    triggered_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    acknowledged_at TIMESTAMP WITH TIME ZONE,
    resolved_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_connectors_tenant ON connectors(tenant_id);
CREATE INDEX idx_connectors_type ON connectors(type);
CREATE INDEX idx_connectors_status ON connectors(status);
CREATE INDEX idx_connector_credentials_connector ON connector_credentials(connector_id);
CREATE INDEX idx_connector_credentials_status ON connector_credentials(status);
CREATE INDEX idx_connector_sync_stats_connector ON connector_sync_stats(connector_id);
CREATE INDEX idx_connector_oauth_states_state ON connector_oauth_states(state);
CREATE INDEX idx_connector_oauth_states_expires ON connector_oauth_states(expires_at);
CREATE INDEX idx_connector_health_metrics_connector ON connector_health_metrics(connector_id);
CREATE INDEX idx_connector_health_metrics_recorded ON connector_health_metrics(recorded_at);
CREATE INDEX idx_connector_incidents_connector ON connector_incidents(connector_id);
CREATE INDEX idx_connector_incidents_status ON connector_incidents(status);
CREATE INDEX idx_connector_health_alerts_connector ON connector_health_alerts(connector_id);
CREATE INDEX idx_connector_health_alerts_type ON connector_health_alerts(alert_type);

-- Cleanup expired OAuth states (run via cron/scheduler)
CREATE OR REPLACE FUNCTION cleanup_expired_oauth_states()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM connector_oauth_states WHERE expires_at < NOW();
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
