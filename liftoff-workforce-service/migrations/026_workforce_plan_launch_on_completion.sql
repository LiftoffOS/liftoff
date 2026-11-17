-- 026: whether the person chose to launch the plan's AI teams as they are built.
--
-- The dashboard's build wizard ends on one choice, Launch Now or Maybe Later.
-- The Chief AI Officer asks the same question when a plan is approved, but its
-- teams are built minutes later by one Cloud Task per spec, so the answer has
-- to be kept on the plan for the task that finishes last to act on. False is
-- what every existing plan did: drafts on the Teams page.

ALTER TABLE workforce_plans
  ADD COLUMN IF NOT EXISTS launch_on_completion BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN workforce_plans.launch_on_completion IS
  'True when the approver chose to start each AI team as soon as it is built (the builder''s Launch Now); false leaves them as drafts (Maybe Later).';
