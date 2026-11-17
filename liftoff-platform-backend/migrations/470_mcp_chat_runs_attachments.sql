-- Migration 470: attachments on liftoff_chat.
--
-- A message sent through a coding tool can now carry documents (as uploads)
-- and pictures (inline, stored through the inbound media path before the run
-- is queued). The worker hands the array to whichever turn function runs the
-- message, exactly as the dashboard composer's request body would. The run
-- row is the only place the array lives between the tool call and the
-- worker, so it is persisted here. RLS on mcp_chat_runs is unchanged.

ALTER TABLE mcp_chat_runs ADD COLUMN IF NOT EXISTS attachments JSONB;
