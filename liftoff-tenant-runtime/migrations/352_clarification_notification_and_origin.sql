-- Migration 352: the parked-blocker notification needs two things the
-- clarification row could not tell it.
--
-- Context: escalations used to fire a durable notification (WS-3.9). Routing a
-- customer-clearable blocker to a pause instead of an escalation replaced that
-- with silence, so a scheduled agent blocked on something a person could fix
-- waited where nobody was looking. The notification is back, and these two
-- columns are what make it correct rather than merely present.
--
-- ── notified_at: at-least-once delivery ────────────────────────────────────
--
-- The notification is one HTTP hop from the runtime to the platform backend,
-- and it is deliberately non-fatal: a pause row must persist even when the
-- notification cannot be sent. Without a marker that is where the story ended.
-- The dedup that stops a 1-minute cron sending 1,440 notifications a day keys
-- on the open row, so the NEXT tick returned early and never retried, and the
-- blocker reached nobody until the row expired.
--
-- With this column the two concerns separate. The row still suppresses a
-- second ASK, and notified_at suppresses a second TELL. A tick that finds an
-- open row nobody was told about retries the send and stamps it. Once stamped
-- it is never sent again for that row.
--
-- NULL on existing rows is correct and self-healing: any open clarification
-- predating this migration is treated as un-notified and gets one notification
-- on the owning agent's next tick.
ALTER TABLE agent_scheduled_invocations ADD COLUMN notified_at TIMESTAMPTZ;

-- ── clarification_origin: a blocker is not a question ──────────────────────
--
-- Both park a run through the same row, and until now nothing downstream could
-- tell them apart:
--
--   'question' — the agent needs a person to choose between options or supply
--                a value. Fine to drop after 24 hours; the answer was only
--                useful in context.
--   'blocker'  — the agent cannot proceed until someone acts outside the
--                product (share a sheet, fix a credential, grant access). Still
--                true at hour 25, so it gets its own expiry window, and its
--                expiry must not bury it in a record the customer never sees.
--
-- It also decides the thread's title and the notification's wording, both of
-- which read wrong when a blocker is announced as a clarification.
--
-- NULL means "written before this column existed", which every consumer must
-- read as 'question' — the pre-existing behaviour, so old rows keep the 24h
-- expiry they were armed with.
ALTER TABLE agent_scheduled_invocations
  ADD COLUMN clarification_origin TEXT
    CHECK (clarification_origin IN ('question', 'blocker'));

-- The dedup lookup runs on every recovery-advisor pause: newest open
-- recovery_llm row for one agent. It now selects notified_at alongside, and the
-- ORDER BY created_at DESC makes this a covering-ish read rather than a scan of
-- the agent's history.
CREATE INDEX IF NOT EXISTS idx_asi_open_clarification
  ON agent_scheduled_invocations (tenant_id, agent_id, created_at DESC)
  WHERE status = 'pending' AND clarification_source = 'recovery_llm';
