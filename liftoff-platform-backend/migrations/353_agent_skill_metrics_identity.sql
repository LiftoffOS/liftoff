-- Drop skill metrics that cannot name the skill they describe, and stop the
-- empty skill id from being a usable key.
--
-- `skill_id` is TEXT and the upsert conflict target is (agent_id, skill_id), so
-- '' is a legal key: every skill reaching the metrics writer without an id
-- shares one row and pools its counters. A row whose skill_name is also empty
-- can be joined to nothing afterwards — it carries counts and a last_used_at for
-- a skill nobody can name.
--
-- CROSS-TENANT MAINTENANCE, so RLS is lifted for the statements rather than
-- scoped to a tenant. agent_skill_metrics is FORCE ROW LEVEL SECURITY and its
-- policy reads current_setting('app.current_tenant_id')::uuid, which the
-- migration runner never sets — the policy would raise
--   error: unrecognized configuration parameter "app.current_tenant_id"
-- and take the whole pending batch down with it. Same shape as 345 and 347.

ALTER TABLE agent_skill_metrics NO FORCE ROW LEVEL SECURITY;

DELETE FROM agent_skill_metrics
WHERE skill_name IS NULL OR skill_name = '';

DELETE FROM agent_skill_metrics
WHERE skill_id IS NULL OR skill_id = '';

ALTER TABLE agent_skill_metrics FORCE ROW LEVEL SECURITY;

ALTER TABLE agent_skill_metrics
  ADD CONSTRAINT agent_skill_metrics_skill_id_nonempty CHECK (skill_id <> '');
