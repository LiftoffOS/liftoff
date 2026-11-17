-- What the reviewer changed before saying yes.
--
-- The gate could only ever answer approve or deny on the call as proposed.
-- Templates promise more than a verdict: "send the draft to the rep to review
-- and adjust pricing or wording, then send it", "the manager finalizes the
-- draft, then publish exactly what they finalized". With no way to hand back a
-- revised body, either the agent's own wording went out or the edit happened
-- somewhere else and what shipped was not what was approved.
--
-- Kept BESIDE pending_tool_calls rather than overwriting it, for two reasons.
-- The row carries tool_calls_hash over the calls as the agent proposed them and
-- verifies it at approval time, so an in-place edit reads as tampering — which
-- is right, because from the hash's point of view it is. And an audit that
-- cannot show what the agent wanted to send next to what a person actually sent
-- has lost the only interesting fact about the review.
--
-- Keyed by the id of the pending tool call each entry replaces. A key with no
-- matching call is ignored rather than dispatched: it names a call that is not
-- happening, and inventing one is worse than dropping it.
--
-- The decision stays 'approved'. A reviewer who fixes a price and sends is
-- approving, not doing a third thing, and a third decision value would fork
-- every binary branch that reads this column for nothing.

ALTER TABLE hitl_approval_requests
  ADD COLUMN IF NOT EXISTS edited_tool_inputs JSONB;

COMMENT ON COLUMN hitl_approval_requests.edited_tool_inputs IS
  'Tool inputs the approver rewrote, keyed by pending tool call id. NULL for an ordinary approval. Replaces the input wholesale rather than merging into it, so a reviewer can remove a recipient and not merely add one.';
