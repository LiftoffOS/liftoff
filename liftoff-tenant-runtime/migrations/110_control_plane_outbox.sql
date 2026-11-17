-- Migration 110: Transactional outbox for control-plane audit log delivery.
--
-- audit_logs writes (local) and the corresponding control-plane POST must
-- succeed or fail together. The fire-and-forget POST that was previously
-- inside insertAuditLog() could silently drop rows whenever the control
-- plane was unavailable. The outbox pattern makes the dual-write atomic:
-- both inserts happen in a single DB transaction; a background worker
-- delivers outbox rows with retries and marks them delivered or failed.

CREATE TABLE IF NOT EXISTS control_plane_outbox (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint        TEXT        NOT NULL,
  payload         JSONB       NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'delivered', 'failed')),
  retry_count     INT         NOT NULL DEFAULT 0,
  last_attempted_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast scan for the worker: only pending rows, ordered by age.
CREATE INDEX IF NOT EXISTS idx_control_plane_outbox_pending
  ON control_plane_outbox (created_at)
  WHERE status = 'pending';
