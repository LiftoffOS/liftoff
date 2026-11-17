-- 492: who sent each message to Liftoff and to the Insights Manager.
--
-- liftoff_chat_messages and insights_chat_messages had no per-message sender.
-- Any workspace member can post into any thread on these surfaces (the message
-- routes check membership only), so the thread's account_id says who started
-- the conversation and nothing about who wrote a given line, and the pages put
-- no name on a human bubble. Attributing every human message to the thread's
-- creator would be an invention the product does not make. Team chat has real
-- senders (agent_chat_turns.sender_account_id, migration 294) and is
-- unaffected; the Chief AI Officer's table gains the same column in the
-- workforce service (its migration 027).
--
-- Set on EVERY human-message write from now on, through each repository's
-- discriminated input: a user message cannot be appended without a sender.
-- Rows written before this migration stay NULL and read as "Workspace member"
-- in the workspace export, which is the reader of this column.
--
-- Neither table carries tenant_id, so neither is RLS and a plain ADD COLUMN is
-- all this is; the FK to accounts follows agent_chat_turns.
ALTER TABLE liftoff_chat_messages
  ADD COLUMN sender_account_id UUID REFERENCES accounts(id);

ALTER TABLE insights_chat_messages
  ADD COLUMN sender_account_id UUID REFERENCES accounts(id);

COMMENT ON COLUMN liftoff_chat_messages.sender_account_id IS
  'accounts.id of the person who wrote a user message. NULL for assistant rows and for user rows written before migration 492.';
COMMENT ON COLUMN insights_chat_messages.sender_account_id IS
  'accounts.id of the person who wrote a user message. NULL for assistant rows and for user rows written before migration 492.';
