-- Migration 275: allow 'teams' as an agent_chat_threads.channel
--
-- agent_chat_threads.channel is VARCHAR(20) with CHECK (channel IN ('web','slack'))
-- from migration 105. The Teams adapter calls findOrCreateThread(..., 'teams', ...),
-- which would violate the CHECK without this. The inline CHECK from migration 105
-- is auto-named agent_chat_threads_channel_check. 'teams' fits VARCHAR(20).

ALTER TABLE agent_chat_threads DROP CONSTRAINT agent_chat_threads_channel_check;
ALTER TABLE agent_chat_threads ADD CONSTRAINT agent_chat_threads_channel_check
  CHECK (channel IN ('web','slack','teams'));
