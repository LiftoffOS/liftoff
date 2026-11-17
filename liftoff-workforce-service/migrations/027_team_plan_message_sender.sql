-- 027: who sent each message to the Chief AI Officer, and an index for the
-- workspace export's message feed.
--
-- team_plan_messages had no per-message sender. Any workspace member can post
-- into any plan thread (the message routes check membership only), so the
-- thread's account_id says who started the conversation and nothing about who
-- wrote a given line. Attributing every human message to the thread's creator
-- would be an invention the product does not make; platform-backend's Liftoff
-- and Insights tables gain the same column in the same change.
--
-- Set on EVERY human-message write from now on, through the repository's
-- discriminated input (a user message cannot be appended without a sender).
-- Rows written before this migration stay NULL and read as "Workspace member"
-- in the export. A bare UUID like every other account id here: accounts live
-- in platform-backend's database, so there is nothing to foreign-key it to
-- (the same trade migration 014 documents for presence).
ALTER TABLE team_plan_messages ADD COLUMN sender_account_id UUID;

COMMENT ON COLUMN team_plan_messages.sender_account_id IS
  'platform-backend accounts.id of the person who wrote a user message. NULL for assistant rows and for user rows written before migration 027.';

-- The export walks every message of a tenant in one ordered pass keyed on
-- (created_at, id). Messages carry no tenant column; the feed joins through
-- team_plan_threads, which is tenant-scoped, and this index serves the walk.
CREATE INDEX idx_team_plan_messages_created ON team_plan_messages (created_at, id);
