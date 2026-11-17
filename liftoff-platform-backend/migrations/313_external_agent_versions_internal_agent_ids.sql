-- 313_external_agent_versions_internal_agent_ids.sql
--
-- Finish the rename migration 055 started.
--
-- 055 renamed external_agents.allowed_team_ids → allowed_internal_agent_ids as
-- part of the team → internal_agent rename, and updated the code to match. It
-- did not rename the SAME column on external_agent_versions, which migration
-- 048 created alongside it. createVersion() writes
-- allowed_internal_agent_ids to the versions table, so since 055 every call has
-- failed with:
--
--   column "allowed_internal_agent_ids" of relation "external_agent_versions"
--   does not exist
--
-- createVersion is on four paths — create, update, rollback and rediscover —
-- so all four have been broken, and rediscover being broken is a large part of
-- why an external agent's tool snapshot could sit stale indefinitely: the
-- manual "rediscover" button could not have worked either.
--
-- The automated health-sweep refresh (migration 312) exercises rediscover,
-- and its non-fatal handler logs the error instead of silently skipping, so
-- the refresh is a no-op until this lands.
--
-- Rename rather than add-and-backfill: it is the same column with the same
-- data, and renaming keeps the version snapshot's shape identical to the live
-- external_agents row it snapshots.

BEGIN;

ALTER TABLE external_agent_versions
  RENAME COLUMN allowed_team_ids TO allowed_internal_agent_ids;

COMMENT ON COLUMN external_agent_versions.allowed_internal_agent_ids IS
  'Snapshot of external_agents.allowed_internal_agent_ids at this version. Holds platform internal_agents.id values — NOT tenant-runtime agents.id, which is a disjoint space (see ADR-039). Renamed in migration 313 to finish the team → internal_agent rename that migration 055 applied to external_agents but missed here.';

COMMIT;
