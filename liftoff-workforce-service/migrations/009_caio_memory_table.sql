-- Migration 009: CAIO memory — dedicated cross-thread table
--
-- Replaces the rolling_summary.memory JSONB approach from migration 005.
-- Memory is now keyed by (tenant_id, account_id, key) so entries persist
-- across thread deletion and are queryable by layer (personal/team/global).
--
-- The caio_memory_updated_at column on team_plan_threads (added in 005)
-- is retained for backwards compatibility but is no longer the primary
-- storage; it now functions as a cache-invalidation hint only.

CREATE TABLE caio_memory (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL,
  account_id  UUID        NOT NULL,
  key         TEXT        NOT NULL,
  layer       TEXT        NOT NULL DEFAULT 'personal'
                CHECK (layer IN ('personal', 'team', 'global')),
  content     TEXT        NOT NULL,
  tags        TEXT[]      NOT NULL DEFAULT '{}',
  scope_key   TEXT,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One entry per (tenant, account, key). UPSERT on conflict.
  UNIQUE (tenant_id, account_id, key)
);

CREATE INDEX caio_memory_account_idx
  ON caio_memory (tenant_id, account_id);

-- Team-layer entries are readable by all accounts in the tenant.
CREATE INDEX caio_memory_team_idx
  ON caio_memory (tenant_id)
  WHERE layer = 'team';

-- Partial index for TTL expiry sweeper.
CREATE INDEX caio_memory_expires_idx
  ON caio_memory (expires_at)
  WHERE expires_at IS NOT NULL;

COMMENT ON TABLE caio_memory IS
  'Cross-thread persistent memory for the CAIO agent. '
  'Keyed by (tenant_id, account_id, key); layer controls sharing scope.';
COMMENT ON COLUMN caio_memory.layer IS
  'personal = only the owning account; team = all tenant members; global = system-wide.';
COMMENT ON COLUMN caio_memory.scope_key IS
  'Optional secondary scope discriminator (e.g. plan_id) for namespacing personal entries.';
