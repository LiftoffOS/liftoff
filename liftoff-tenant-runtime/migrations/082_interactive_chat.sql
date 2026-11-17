-- Migration 082: Interactive chat support
--
-- Adds the chat_feedback_queue table for storing user feedback signals
-- from interactive chat sessions. Feedback is processed asynchronously
-- by the chat-feedback-extractor (periodic Cloud Scheduler job) to
-- extract structured learnings and save them to agent memory.
--
-- Also extends the threads table with an execution_path discriminator
-- so the platform and UI can distinguish autonomous task threads from
-- interactive chat threads.

-- ============================================================================
-- 1. Extend threads with execution_path discriminator
-- ============================================================================

ALTER TABLE threads ADD COLUMN execution_path TEXT NOT NULL DEFAULT 'autonomous'
  CHECK (execution_path IN ('autonomous', 'interactive'));

COMMENT ON COLUMN threads.execution_path IS
  'Distinguishes autonomous task threads from interactive chat threads';

-- Partial index for fast interactive thread lookups (chat UI list)
CREATE INDEX idx_threads_interactive
  ON threads (tenant_id, agent_id, created_at DESC)
  WHERE execution_path = 'interactive';

-- ============================================================================
-- 2. Chat feedback queue
-- ============================================================================

CREATE TABLE chat_feedback_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  feedback_type TEXT NOT NULL CHECK (feedback_type IN ('correction', 'positive', 'preference')),
  content TEXT NOT NULL,
  user_id TEXT NOT NULL,
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  processed_at TIMESTAMPTZ,
  extraction_result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE chat_feedback_queue IS
  'Queues user feedback signals from interactive chat for async extraction by the feedback extractor';

-- Unprocessed feedback lookup: the extractor queries this on each run
CREATE INDEX idx_cfq_unprocessed
  ON chat_feedback_queue (tenant_id, agent_id, created_at)
  WHERE processed = FALSE;

-- RLS: tenant runtime uses app.tenant_id (see migration 079)
ALTER TABLE chat_feedback_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON chat_feedback_queue
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
