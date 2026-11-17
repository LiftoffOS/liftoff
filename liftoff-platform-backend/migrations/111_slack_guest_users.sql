-- Allow Slack users to chat with agents without a matching Liftoff account.
--
-- Previously, agent_chat_threads.account_id was NOT NULL, which meant the
-- Slack adapter refused to process messages from anyone whose Slack email
-- didn't match a row in the accounts table.  The agent would respond with
-- "I don't recognize you" — bad UX for workspace members who simply want
-- to DM the agent.
--
-- Making account_id nullable lets the Slack adapter create threads for
-- guest users (anyone in the Slack workspace) without requiring them to
-- have a Liftoff account.  The FK is preserved so existing rows and web-
-- originated threads still reference a valid account when present.

ALTER TABLE agent_chat_threads ALTER COLUMN account_id DROP NOT NULL;

-- added_by on participants tracks who looped an agent into the thread.
-- For Slack guest users there's no account row to reference.
ALTER TABLE agent_chat_thread_participants ALTER COLUMN added_by DROP NOT NULL;
