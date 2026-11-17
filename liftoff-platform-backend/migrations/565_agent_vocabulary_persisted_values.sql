-- Three persisted values stop saying "team" about one agent.
--
-- The vocabulary rename reached prose, identifiers and the published contracts
-- in earlier changes. These three are stored STRINGS: they sit in rows, in
-- column defaults and in CHECK constraints, so a code-side edit alone would
-- have the application writing a value its own table rejects.
--
--   mcp_chat_runs.target_kind       'team'          -> 'agent'
--   platform_vendor_policy.area     'team_shaping'  -> 'agent_shaping'
--   notifications.type              'team_activity' -> 'agent_activity'
--
-- Each of the three means ONE piece of software: target_kind distinguishes an
-- agent from a platform assistant, team_shaping is the lever deciding what an
-- agent IS, and team_activity is a notification about what an agent did. Under
-- the new vocabulary all three were simply wrong.
--
-- WHAT IS DELIBERATELY NOT HERE, because "team" in it is correct rather than
-- stale, and renaming would make the schema lie:
--
--   * `team_plan` — the Chief AI Officer's thread kind, its nine tables in the
--     workforce database, its share-link kind, its notification surface and its
--     proto `assistant` value. A team plan is a plan for a TEAM: the people and
--     the agents together, which is exactly the definition the voice block
--     keeps ("a team is people and agents together"). It is also the one of
--     these values that has escaped: it is inside share URLs already issued to
--     customers, and the tenant runtime reads the workforce service's
--     team_plan_* tables by raw SQL across a database boundary, where no
--     compiler and no HTTP contract would catch a rename.
--   * `caio_memory.layer = 'team'` in the workforce database, which means all
--     members of the workspace. That is people. Renaming it to 'agent' would
--     invert its meaning.
--
-- ORDER WITHIN EACH BLOCK: drop the constraint, rewrite the rows, change the
-- default, then re-add the constraint. Rewriting rows while the old CHECK is
-- live fails on the new value; adding the new CHECK before the rewrite fails on
-- the old ones.

BEGIN;

-- 1. mcp_chat_runs.target_kind ------------------------------------------------
-- mcp_chat_runs is FORCE ROW LEVEL SECURITY and the migrate job runs as
-- liftoff_app, which has no BYPASSRLS. A migration session sets no
-- app.current_tenant_id, so the policy is evaluated against nothing and the
-- UPDATE raises rather than matching zero rows. Dropping FORCE around the write
-- is the convention here, and
-- scripts/ci-fences/migration-force-rls-fence.sh is what insists on it — a
-- local run as a superuser passes regardless, so the fence is what catches it.
ALTER TABLE mcp_chat_runs DROP CONSTRAINT IF EXISTS mcp_chat_runs_target_kind_check;
ALTER TABLE mcp_chat_runs DROP CONSTRAINT IF EXISTS mcp_chat_runs_agent_id_matches_kind;

ALTER TABLE mcp_chat_runs ALTER COLUMN target_kind DROP DEFAULT;
ALTER TABLE mcp_chat_runs NO FORCE ROW LEVEL SECURITY;
UPDATE mcp_chat_runs SET target_kind = 'agent' WHERE target_kind = 'team';
ALTER TABLE mcp_chat_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE mcp_chat_runs ALTER COLUMN target_kind SET DEFAULT 'agent';

ALTER TABLE mcp_chat_runs ADD CONSTRAINT mcp_chat_runs_target_kind_check
  CHECK (target_kind IN ('agent', 'liftoff', 'insights', 'caio'));
ALTER TABLE mcp_chat_runs ADD CONSTRAINT mcp_chat_runs_agent_id_matches_kind
  CHECK ((target_kind = 'agent') = (agent_id IS NOT NULL));

-- 2. platform_vendor_policy.area ----------------------------------------------
ALTER TABLE platform_vendor_policy DROP CONSTRAINT IF EXISTS platform_vendor_policy_area_check;

UPDATE platform_vendor_policy SET area = 'agent_shaping' WHERE area = 'team_shaping';

ALTER TABLE platform_vendor_policy ADD CONSTRAINT platform_vendor_policy_area_check
  CHECK (area IN ('assistants', 'agent_shaping', 'quiet_work', 'safety'));

-- 3. notifications.type --------------------------------------------------------
-- notifications is tenant-scoped and FORCE RLS, so this statement runs as the
-- migration role against every tenant's rows; there is no per-tenant scope to
-- set and nothing here reads a tenant id.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;

UPDATE notifications SET type = 'agent_activity' WHERE type = 'team_activity';

ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('task_update', 'agent_activity', 'escalation'));

DO $verify$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM mcp_chat_runs WHERE target_kind = 'team';
  IF n <> 0 THEN RAISE EXCEPTION 'migration 565: % mcp_chat_runs row(s) still say target_kind=team', n; END IF;

  SELECT count(*) INTO n FROM platform_vendor_policy WHERE area = 'team_shaping';
  IF n <> 0 THEN RAISE EXCEPTION 'migration 565: % policy row(s) still say area=team_shaping', n; END IF;

  SELECT count(*) INTO n FROM notifications WHERE type = 'team_activity';
  IF n <> 0 THEN RAISE EXCEPTION 'migration 565: % notification(s) still say type=team_activity', n; END IF;

  -- The seeded policy row must still exist under its new name. A rewrite that
  -- matched nothing would pass every check above by doing nothing at all.
  SELECT count(*) INTO n FROM platform_vendor_policy WHERE area = 'agent_shaping';
  IF n < 1 THEN RAISE EXCEPTION 'migration 565: the agent_shaping policy row is missing'; END IF;
END
$verify$;

COMMIT;
