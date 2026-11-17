-- 430: whether a clarification is an item on the review page.
--
-- Under the Escalation setting "Only exceptions" (hitl-enforcement/
-- surfacing.ts) a plain question still parks the run, because the run cannot
-- proceed without the value, but it is not an exception: nobody is notified
-- and it is not an item on the review page. The run's paused state carries it
-- instead: the question is the last message of the AI team's chat thread, the
-- team shows as waiting, and a reply in that thread answers it. A blocker, a
-- question under any other setting, and every row written before this column
-- existed stay on the review page, which the default keeps true.
--
-- Written at creation by the same decision that withheld the notification,
-- and set back to true by the one path that later announces the row (a
-- notification links to the review queue, so what it announces is on it).
-- The review queue's listing and count read it and nothing else does.
-- Answering, declining and expiry transition on status alone, so a question
-- filed here is still answered by a reply in its thread, by a direct link,
-- and by the expiry sweeper exactly as a listed one is.
ALTER TABLE agent_scheduled_invocations
  ADD COLUMN IF NOT EXISTS review_listed BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN agent_scheduled_invocations.review_listed IS
  'Whether a clarification-expiry row is an item on the review page. FALSE for a plain question parked under the Escalation setting "Only exceptions": the run pauses and the question waits in its chat thread, with no notification and no review item. TRUE on every other row and on every other objective.';
