-- Migration 553: which vendor powers the PLATFORM's own LLM work, by area.
--
-- A workspace's vendor choice answers what ITS AI teams run on. It must not
-- answer what Liftoff's own assistants run on: those are the platform's
-- product, not the customer's configuration, and a workspace switching to Qwen
-- should not move the Chief AI Officer with it.
--
-- The platform side had no answer at all. `llmClient.complete` takes the
-- provider as an argument, 36 of its 37 callers pass nothing, and the
-- fallthrough is `getFirstAvailableProvider()` — Anthropic, by priority order.
-- A default by accident rather than a decision, changeable only by editing the
-- priority list and shipping.
--
-- FOUR AREAS, one row each (see src/model-registry/platform-vendor-policy.ts
-- for what lands in which):
--   assistants    what a person reads
--   team_shaping  what decides what an AI team IS
--   quiet_work    high-volume and invisible
--   safety        gates, where a wrong answer is a security outcome
--
-- WHY A TABLE AND NOT A CONSTANT. The switch has to be fast and must not need a
-- redeploy (product decision): a vendor timing out at 2am should be a click,
-- not a build. The code constant survives as the FALLBACK — see
-- PLATFORM_VENDOR_FALLBACK — which is what resolves before this table is read
-- and what keeps resolving if the read fails, so a database blip degrades to
-- today's behaviour rather than to nothing.
--
-- SINGLETON BY AREA, not by tenant. `area` is the primary key and there is no
-- tenant_id: this is the platform's own choice, identical for every workspace,
-- and a tenant column would invite a per-tenant override that the whole point
-- of this table is to keep separate from the workspace dropdown.
--
-- NOT RLS, for the same reason: there is no tenant to scope to. It sits with
-- `models` and `model_pricing` as a global catalog (see repository.ts), so
-- plain reads and writes, no scope wrapper, no FK traps.
--
-- SEEDED TO 'default' FOR EVERY AREA, so applying this migration changes no
-- routing. 'default' means "whatever the platform would have done anyway",
-- which is the pre-existing Anthropic fallthrough. The feature ships inert and
-- becomes live only when somebody moves a lever.
--
-- `vendor` is CHECKed against the Workspace AI vocabulary rather than left
-- free text. The constraint is a hand-written copy of a TypeScript union, which
-- is the shape that has been missed six times on `invocations.provider` — so
-- `src/model-registry/__tests__/platform-vendor-policy-constraint.test.ts`
-- compares the two rather than anyone remembering. 'grok' is admitted here even
-- though the control plane cannot route to it: the constraint is about the
-- vocabulary, and the resolver refuses it at read time with a reason, which is
-- the layer that can explain itself.

BEGIN;

CREATE TABLE IF NOT EXISTS platform_vendor_policy (
  area        TEXT PRIMARY KEY
                CHECK (area IN ('assistants', 'team_shaping', 'quiet_work', 'safety')),
  vendor      TEXT NOT NULL DEFAULT 'default'
                CHECK (vendor IN (
                  'default', 'anthropic', 'openai', 'google',
                  'glm', 'qwen', 'deepseek', 'kimi', 'minimax', 'grok', 'xiaomi'
                )),
  -- Who moved it and when. A runtime-mutable routing decision with no actor is
  -- a change nobody can account for afterwards.
  updated_by  TEXT,
  updated_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE platform_vendor_policy IS
  'Which vendor powers the platform''s own LLM work, by area. NOT a tenant setting: '
  'the workspace dropdown answers what a customer''s AI teams run on, this answers what '
  'Liftoff''s assistants, team-shaping, background and safety work run on. '
  'vendor=''default'' means the platform''s built-in fallthrough.';

COMMENT ON COLUMN platform_vendor_policy.vendor IS
  'A Workspace AI selection. ''grok'' is a valid value but the control plane holds no xAI '
  'client, so the resolver refuses it and keeps the default rather than running GLM under '
  'Grok''s name.';

-- Every area present from the start, so a read never has to distinguish
-- "not configured" from "missing row", and so the admin surface has four rows
-- to show rather than an empty table.
INSERT INTO platform_vendor_policy (area, vendor, updated_by)
VALUES
  ('assistants',   'default', 'migration-553'),
  ('team_shaping', 'default', 'migration-553'),
  ('quiet_work',   'default', 'migration-553'),
  ('safety',       'default', 'migration-553')
ON CONFLICT (area) DO NOTHING;

COMMIT;
