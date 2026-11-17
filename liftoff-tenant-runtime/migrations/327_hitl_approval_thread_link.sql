-- 327_hitl_approval_thread_link
-- Link a chat-originated approval back to the conversation it paused.
--
-- Approvals had no thread column at all: listPendingItemsForTenant selected a
-- literal `NULL::uuid AS thread_id` for the approval arm of its UNION, while the
-- clarification arm carried a real one. That meant the decision path knew the
-- approval id but not the conversation, so nothing could post the outcome back
-- into the thread that stalled.
--
-- Nullable on purpose, and no FK. Workflow, scheduled and sandbox gates have no
-- conversation and must keep creating approvals; the threads themselves live in
-- the platform-control database, so this is a soft reference across a service
-- boundary rather than something Postgres can enforce here.

ALTER TABLE hitl_approval_requests
  ADD COLUMN IF NOT EXISTS thread_id UUID;

COMMENT ON COLUMN hitl_approval_requests.thread_id IS
  'Chat thread this gate paused (agent_chat_threads.id in platform-control). NULL for workflow, scheduled and sandbox gates, which have no conversation to post back into.';

-- Partial: only chat-originated rows carry a thread, and the decision path looks
-- them up one at a time by approval id, so this exists to keep any
-- "outstanding requests on this thread" scan cheap rather than to serve the
-- primary lookup.
CREATE INDEX IF NOT EXISTS idx_hitl_approvals_thread
  ON hitl_approval_requests (thread_id)
  WHERE thread_id IS NOT NULL AND status = 'pending';
