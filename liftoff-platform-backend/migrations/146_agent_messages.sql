-- Agent-to-agent collaboration.
-- Async message queue for peer collaboration between internal agents and Claude Code instances.
-- No stable endpoint required — Claude Code polls via liftoff_read_messages MCP tool.

CREATE TABLE agent_messages (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sender_type      TEXT        NOT NULL CHECK (sender_type IN ('claude_code', 'internal_agent')),
  sender_id        TEXT        NOT NULL,
  recipient_type   TEXT        NOT NULL CHECK (recipient_type IN ('claude_code', 'internal_agent')),
  recipient_id     TEXT        NOT NULL,
  content          TEXT        NOT NULL CHECK (length(content) <= 51200),
  metadata         JSONB       NOT NULL DEFAULT '{}',
  status           TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'read', 'expired')),
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at          TIMESTAMPTZ
);

-- Primary lookup: pending messages for a recipient (liftoff_read_messages tool)
CREATE INDEX idx_agent_messages_recipient
  ON agent_messages (tenant_id, recipient_id, status, created_at)
  WHERE status = 'pending';

-- Outbox lookup: messages sent by a specific key
CREATE INDEX idx_agent_messages_sender
  ON agent_messages (tenant_id, sender_id, created_at DESC);

-- Expiry sweep: daily job marks pending expired messages
CREATE INDEX idx_agent_messages_expiry
  ON agent_messages (expires_at)
  WHERE status = 'pending';
