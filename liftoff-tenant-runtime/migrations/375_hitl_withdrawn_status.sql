-- A question asked in error needs a way to be closed that is not a lie.
--
-- `status` had four values and every one of them makes a claim about a PERSON:
--
--   approved   a person authorised this
--   rejected   a person refused this
--   expired    the expiry path files "Clarification request expired without
--              answer (24h)" / "no operator decision", which reads as a person
--              who ignored it
--
-- So there was no way to close a question that should never have been asked
-- without recording something false about somebody. An approval raised for
-- work already inside the agent's approved workflow, then approved just to
-- unblock the agent, leaves a record saying a human authorised an action nobody
-- should have been asked about.
--
-- `withdrawn` is written by the SYSTEM and only where the row PROVES the
-- question was pointless: the approval is still pending while its invocation
-- reached a terminal outcome that is not 'gated'. The run finished without it,
-- so deciding it can no longer change anything.
--
-- `decision` is deliberately NOT widened. It stays approved | rejected, because
-- a withdrawal is not a decision — nobody decided anything, which is the whole
-- point. Conflating them would put a verdict back on the row.
--
-- Written as a NEW migration rather than an edit to 013: pgmigrations records
-- filenames, so editing an applied migration runs in no database that already
-- has it while a from-scratch rebuild gets the new text, and the two disagree
-- forever. Migration 140 was rewritten four hours after it landed and its
-- rewrite reached no environment.

ALTER TABLE hitl_approval_requests
  DROP CONSTRAINT IF EXISTS hitl_approval_requests_status_check;

ALTER TABLE hitl_approval_requests
  ADD CONSTRAINT hitl_approval_requests_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'withdrawn'));

-- The sweeper's lookup: pending approvals joined to their invocation's outcome.
-- Partial, because it only ever reads rows that are still open.
CREATE INDEX IF NOT EXISTS idx_hitl_approvals_pending_invocation
  ON hitl_approval_requests (invocation_id)
  WHERE status = 'pending' AND invocation_id IS NOT NULL;
