-- Migration 175: add citations to agent_chat_messages
-- citations: JSONB array of Citation objects extracted from agent responses
-- Format: [{ ref: number, filename: string, page?: number, quote: string }]

BEGIN;

ALTER TABLE agent_chat_messages ADD COLUMN citations JSONB;

COMMIT;
