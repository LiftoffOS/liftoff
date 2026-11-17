-- A message carries the content-trust level of the invocation that sent it,
-- stamped server-side by the platform-tools send route (never from model-provided
-- metadata). When the read path returns a message whose origin_trust is
-- untrusted_inbound, the reading run upgrades to untrusted_inbound so its
-- subsequent write/spawn tool calls gate. Existing rows are trusted.
ALTER TABLE agent_messages
  ADD COLUMN IF NOT EXISTS origin_trust TEXT NOT NULL DEFAULT 'trusted'
    CHECK (origin_trust IN ('trusted', 'untrusted_inbound'));

COMMENT ON COLUMN agent_messages.origin_trust IS
  'Content trust of the sending invocation; the reader upgrades when any returned message is untrusted_inbound.';
