-- Migration 029: work that is bigger than one Chief AI Officer turn goes on
-- as a job.
--
-- A turn is one stream, bounded by its rounds, the model's window and the
-- stream's clock. When a bound closes a turn with work still to do, the
-- model could only say "say the word and I will continue", and the next turn
-- started blind. Now the closing reply carries a verdict (model-only: the
-- line is stripped before anyone reads it), and an unfinished turn queues a
-- CONTINUATION: a row here and a Cloud Task on a queue of its own
-- (workforce-chat-continuations-{env}, twenty attempts with backoff). The
-- task handler claims the row, checks the thread is free and claims the
-- turn, re-reads the row, and runs the same turn loop as a continuation: no
-- user row, the origin message's account and id kept for admission,
-- attribution and the reply notification.
--
-- The same table, columns and states as platform-backend's chat_continuations
-- (its migration 514), which serves Liftoff and the Insights Manager; this
-- one lives here because the Chief AI Officer's turns and messages do.
--
--   queued     inserted while the turn is still claimed; what a new person
--              message on the thread cancels
--   claimed    a worker took it (a claim is not the turn); a person's message
--              cancels this too, and the worker sees that at its recheck
--   running    the worker claimed the turn and the loop is under way
--   done | cancelled | failed   terminal; a row is never left queued after
--              the queue has given up (the worker marks the last delivery
--              failed itself)

BEGIN;

CREATE TABLE chat_continuations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  surface           TEXT NOT NULL DEFAULT 'caio' CHECK (surface = 'caio'),
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
  UNIQUE (origin_message_id, ordinal),
  FOREIGN KEY (thread_id, tenant_id)
    REFERENCES team_plan_threads (id, tenant_id) ON DELETE CASCADE
);

-- The thread's live continuations: what a new person message cancels and
-- what the thread's status read reports.
CREATE INDEX idx_chat_continuations_thread_live
  ON chat_continuations (tenant_id, thread_id)
  WHERE status IN ('queued', 'claimed', 'running');

ALTER TABLE chat_continuations ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_continuations_tenant_isolation ON chat_continuations
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON chat_continuations TO workforce_app;

COMMENT ON TABLE chat_continuations IS
  'A continuation of a Chief AI Officer turn a bound closed with work still to do: one row per continuation, at most five per person message (origin_message_id, ordinal), run by the workforce-chat-continuations Cloud Tasks queue. queued and claimed rows are cancelled by a new person message on the thread.';

COMMIT;
