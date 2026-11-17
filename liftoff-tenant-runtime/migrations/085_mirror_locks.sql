-- mirror_locks
-- Per-tenant-per-repo mirror population lock. Prevents concurrent clone/fetch
-- of the same mirror from multiple turns.

CREATE TABLE IF NOT EXISTS mirror_locks (
  tenant_id UUID NOT NULL,
  owner VARCHAR(100) NOT NULL,
  repo VARCHAR(100) NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 minutes',
  acquired_by_invocation_id UUID NOT NULL,
  PRIMARY KEY (tenant_id, owner, repo)
);

CREATE INDEX IF NOT EXISTS idx_mirror_locks_expires
  ON mirror_locks (expires_at);

COMMENT ON TABLE mirror_locks IS
  'Per-tenant git mirror clone/fetch lock. Heartbeat every 5 min, 30 min expiry.';
