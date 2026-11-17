-- Migration 174: add message_type and attachments to agent_chat_messages
-- message_type: e.g. 'file_output' to distinguish special message kinds
-- attachments: JSONB array of attachment objects (e.g. generated file references)

BEGIN;

ALTER TABLE agent_chat_messages
  ADD COLUMN message_type TEXT,
  ADD COLUMN attachments  JSONB;

COMMIT;
