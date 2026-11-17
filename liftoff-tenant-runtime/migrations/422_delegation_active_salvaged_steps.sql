-- 422_delegation_active_salvaged_steps
-- A delegated child that finished a step from partial material says so on
-- the registry row it reports through.
--
-- A workflow step interrupted after doing read-only work is finished by a
-- salvage turn from what its tools had already returned, and the result
-- names the step (`TaskExecutionResult.salvagedSteps`). A fan-out parent
-- reads its children's answers back off `delegation_active` when the fan-out
-- was interrupted by a human approval (reawaitInFlightDelegations), so a
-- fact carried only in memory would reach the parent on one path and not
-- the other. Written beside `anomalies`, for the same reason that column
-- exists, and read back the same way.

ALTER TABLE delegation_active
  ADD COLUMN IF NOT EXISTS salvaged_steps jsonb;
