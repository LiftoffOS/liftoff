CREATE TABLE web_inflight_requests (
  request_id UUID PRIMARY KEY,
  tenant_id  UUID NOT NULL,
  agent_id   UUID NOT NULL,
  vendor     TEXT NOT NULL CHECK (vendor IN ('webclaw','anchor','browserbase')),
  tool_name  TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_inflight_vendor                 ON web_inflight_requests (vendor);
CREATE INDEX idx_inflight_vendor_tenant          ON web_inflight_requests (vendor, tenant_id);
CREATE INDEX idx_inflight_vendor_tenant_agent    ON web_inflight_requests (vendor, tenant_id, agent_id);
CREATE INDEX idx_inflight_expires                ON web_inflight_requests (expires_at);

CREATE TABLE web_waiters (
  waiter_id  UUID PRIMARY KEY,
  vendor     TEXT NOT NULL CHECK (vendor IN ('webclaw','anchor','browserbase')),
  tenant_id  UUID NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_waiters_vendor   ON web_waiters (vendor);
CREATE INDEX idx_waiters_expires  ON web_waiters (expires_at);
