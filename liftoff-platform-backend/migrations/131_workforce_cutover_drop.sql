-- Migration 131: Drop legacy workforce-plans tables from platform-backend post-cutover.
-- Prerequisites: liftoff-workforce-service live and routing all traffic.
-- Applied automatically by node-pg-migrate on next platform-backend-migrate execution.

BEGIN;

-- Drop FK column on internal_agents before dropping the referenced table,
-- so the cascade intent is explicit and the column is fully removed.
ALTER TABLE internal_agents DROP COLUMN IF EXISTS workforce_plan_id;

-- Drop child tables first to respect FK ordering.
DROP TABLE IF EXISTS team_plan_rate_limit_events CASCADE;
DROP TABLE IF EXISTS team_plan_messages CASCADE;
DROP TABLE IF EXISTS team_plan_threads CASCADE;
DROP TABLE IF EXISTS workforce_plans CASCADE;

COMMIT;
