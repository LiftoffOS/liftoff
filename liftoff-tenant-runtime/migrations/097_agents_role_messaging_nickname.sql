-- Add role and messaging_nickname to agents table.
-- The interactive chat system-prompt builder (chat-turn-handler.ts loadAgentMeta)
-- queries these columns; they were never migrated, causing "column does not exist"
-- errors and "Chat turn failed" for every chat request.
--
-- agents.name stores the agent's role string (mirrors internal_agents.role from PB).
-- Backfill role = name so existing agents work immediately without re-sync.
-- messaging_nickname mirrors internal_agents.messaging_nickname (short chat alias);
-- populated on future agent creates/updates via subscriber events.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS role TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS messaging_nickname TEXT;

-- Backfill: agents.name IS the role string (set from internal_agents.role via Pub/Sub)
UPDATE agents SET role = name WHERE role IS NULL;
