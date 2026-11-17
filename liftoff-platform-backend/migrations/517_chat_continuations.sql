-- Migration 517: work that is bigger than one turn goes on as a job.
--
-- A platform-assistant turn (Liftoff, the Insights Manager) is one stream
-- under a thread lock, bounded by its rounds, the model's window and the
-- stream's clock. When a bound closes a turn with work still to do, the
-- model could only say "say the word and I will continue", and the next turn
-- started blind. Now the closing reply carries a verdict (model-only: the
-- line is stripped before anyone reads it), and an unfinished turn queues a
-- CONTINUATION: a row here, and a Cloud Task on a queue of its own
-- (chat-continuations-{env}, twenty attempts with backoff, so a continuation
-- waiting on a busy thread lock is re-delivered while a chat run that throws
-- is not re-run twenty times). The worker claims the row, takes the thread
-- lock, re-reads the row under the lock, and runs the same turn loop as a
-- continuation: no user row, the origin message's account and id kept for
-- admission, attribution and the reply notification.
--
-- One row per continuation; `ordinal` is its place in the chain for the
-- person's message (`origin_message_id`), at most five (the loop's cap).
--
--   queued     inserted while the turn still holds the lock; what a new
--              person message on the thread cancels
--   claimed    a worker took it (a claim is NOT the lock); a person's
--              message cancels this too, and the worker sees that at its
--              recheck under the lock
--   running    the worker holds the lock and the turn is under way
--   done | cancelled | failed   terminal; a row is never left queued after
--              the queue has given up (the worker marks the last delivery
--              failed itself)
--
-- The Chief AI Officer's turns run in the workforce service, which keeps the
-- same table in its own database. Tenant data, RLS as every tenant table.

CREATE TABLE IF NOT EXISTS chat_continuations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  surface           TEXT NOT NULL CHECK (surface IN ('liftoff', 'insights', 'caio')),
  thread_id         UUID NOT NULL,
  account_id        UUID NOT NULL,
  origin_message_id UUID NOT NULL,
  ordinal           INTEGER NOT NULL CHECK (ordinal >= 1),
  reason            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'claimed', 'running', 'done', 'cancelled', 'failed')),
  claimed_at        TIMESTAMPTZ,
  worker_id         TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at       TIMESTAMPTZ,
  UNIQUE (origin_message_id, ordinal)
);

-- The thread's live continuations: what a new person message cancels and
-- what the thread's status read reports.
CREATE INDEX IF NOT EXISTS idx_chat_continuations_thread_live
  ON chat_continuations (tenant_id, thread_id)
  WHERE status IN ('queued', 'claimed', 'running');

ALTER TABLE chat_continuations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_continuations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_continuations
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE chat_continuations IS
  'A continuation of a platform-assistant turn a bound closed with work still to do: one row per continuation, at most five per person message (origin_message_id, ordinal), run by the chat-continuations Cloud Tasks queue through the MCP chat-run worker. queued and claimed rows are cancelled by a new person message on the thread.';
