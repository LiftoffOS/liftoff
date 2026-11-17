-- 419: what happened to a clarification, and who did it; indexes for the
-- review history feeds.
--
-- A clarification row's status alone cannot say how it was resolved. `fired`
-- is both "answered, and the anchor row was then flipped" and "expired with
-- no answer"; the review answer, the review decline and the in-chat answer all
-- move a row to `resume_inflight` and record nothing about who moved it. The
-- audit write on the review path is fire-and-forget and the in-chat answer
-- writes no audit row at all, so the outcome was recoverable from nowhere.
--
-- Four columns, written IN THE SAME UPDATE that flips the status at every site
-- that resolves a clarification (review answer, review decline, in-chat
-- answer, the three expiry branches), so an outcome cannot exist without its
-- transition. Rows resolved before this migration keep NULLs and read as
-- "Resolved" with no actor.
--
-- resolved_by is the control plane's accounts.id when a signed-in person
-- resolved it. resolved_by_label exists because the in-chat answer path
-- receives a Slack or Teams guest's display name and no account; without it a
-- guest's answer would record an outcome with no actor.
ALTER TABLE agent_scheduled_invocations
  ADD COLUMN resolution_kind TEXT CHECK (resolution_kind IN ('answered', 'declined', 'expired')),
  ADD COLUMN resolved_by TEXT,
  ADD COLUMN resolved_by_label TEXT,
  ADD COLUMN resolved_at TIMESTAMPTZ;

COMMENT ON COLUMN agent_scheduled_invocations.resolution_kind IS
  'How a clarification-expiry row was resolved: answered, declined or expired. NULL on rows resolved before migration 419 and on every other objective.';
COMMENT ON COLUMN agent_scheduled_invocations.resolved_by IS
  'Platform-backend accounts.id of the signed-in person who resolved the clarification. NULL for an expiry and for a guest.';
COMMENT ON COLUMN agent_scheduled_invocations.resolved_by_label IS
  'Display name of a Slack or Teams guest who answered in chat with no account. NULL when resolved_by is set.';
COMMENT ON COLUMN agent_scheduled_invocations.resolved_at IS
  'When the resolution was recorded; written in the same statement as the status transition.';

-- The review history feeds read every status of a tenant's approvals and
-- clarifications in one ordered pass over (created_at, id). The existing
-- review indexes are partial (WHERE status = 'pending', migration 349; the
-- notify one, 366) or ordered for the queue (264, 352); an all-status scan
-- ordered (created_at, id) needs its own.
CREATE INDEX IF NOT EXISTS idx_hitl_approvals_history
  ON hitl_approval_requests (tenant_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_clarifications_history
  ON agent_scheduled_invocations (tenant_id, created_at, id)
  WHERE objective = 'clarification-expiry';
