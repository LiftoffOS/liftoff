-- Append-only audit log for every create, update, delete, and supersession event on the
-- memories table. memory_id has no FK so records survive the cleanup job's hard deletes.
-- content is NULL for pii/sensitive classifications (never audit-log plaintext PII).

CREATE TABLE memory_audit_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id   UUID        NOT NULL,
  agent_id    UUID,
  tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type  TEXT        NOT NULL CHECK (event_type IN ('created', 'updated', 'deleted', 'superseded')),
  content     TEXT,
  tags        TEXT[]      NOT NULL DEFAULT '{}',
  metadata    JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX memory_audit_log_memory_idx ON memory_audit_log(memory_id, created_at DESC);
CREATE INDEX memory_audit_log_tenant_idx ON memory_audit_log(tenant_id, agent_id, created_at DESC);
