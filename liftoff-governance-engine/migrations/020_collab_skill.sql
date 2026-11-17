-- Migration 020: CollabSkill posterior store — sibling of agent_action_trust.
--
-- SHADOW SUBSTRATE. Written only by the collab-skill rollup job (stateless full
-- recompute + delete-stale per model_version); read only by
-- GET /api/governance/collab-skill. Nothing consults it for enforcement.
--
-- model_version is part of the unique key so candidate models run side-by-side.
-- computed_in_run holds the rollup run id and is the delete-stale predicate.
--
-- RLS: ENABLE + tenant-isolation policy on app.current_tenant_id, matching
-- migration 019. The rollup connects as the table owner (governance_app), which
-- bypasses RLS (the table is ENABLE, not FORCE); the tenant-scoped read goes
-- through withTenantScope().

CREATE TABLE collab_skill (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  entity_type     TEXT NOT NULL CHECK (entity_type IN ('agent','human','backbone')),
  entity_id       TEXT NOT NULL,
  scope           TEXT NOT NULL DEFAULT 'global',
  mu              DOUBLE PRECISION NOT NULL DEFAULT 0,
  sigma           DOUBLE PRECISION NOT NULL DEFAULT 1,
  n_observations  INTEGER NOT NULL DEFAULT 0,
  model_version   TEXT NOT NULL,
  computed_in_run TEXT NOT NULL,
  last_match_at   TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_collab_skill_unique
  ON collab_skill (tenant_id, entity_type, entity_id, scope, model_version);
CREATE INDEX idx_collab_skill_tenant_type
  ON collab_skill (tenant_id, entity_type, model_version);

ALTER TABLE collab_skill ENABLE ROW LEVEL SECURITY;

CREATE POLICY collab_skill_tenant_isolation ON collab_skill
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- set_updated_at() is defined in migration 001.
CREATE TRIGGER collab_skill_updated_at BEFORE UPDATE ON collab_skill
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
