-- A run that parked is not a run waiting on a person.
--
-- `invocations.outcome` gained 'gated' in migration 329, for the run that stops
-- and waits on a human. The wall-clock continuation then introduced a second
-- kind of stop: the invocation runs out of clock at a step boundary, schedules
-- its OWN continuation, and resumes with nobody asked for anything.
--
-- That mapped to 'gated' because it was the closest existing member, and every
-- consumer of the column reads 'gated' as "someone owes this a decision".
-- So a run that parks records 'gated' with a fired `continuation:` row at the
-- same second and no approval request anywhere: the agent reports
-- WAITING_FOR_HUMAN and its thread reads 'waiting_on_human' while it is, in
-- fact, mid-sentence.
--
-- Same move 329 made, for the same stated reason: overloading a member that
-- already means something else is how the column stops answering the question
-- it exists for.
ALTER TABLE invocations DROP CONSTRAINT IF EXISTS invocations_outcome_check;
ALTER TABLE invocations ADD CONSTRAINT invocations_outcome_check
  CHECK (outcome IN ('success', 'error', 'escalated', 'gated', 'parked'));

COMMENT ON COLUMN invocations.outcome IS
  'How the invocation ended. success | error | escalated (handed to a person) | '
  'gated (stopped, a person owes it a decision) | parked (stopped at a step '
  'boundary on the wall clock, its own continuation already scheduled).';
