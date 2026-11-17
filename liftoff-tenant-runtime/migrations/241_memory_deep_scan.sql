-- WS-8.2 — Layer 2 deep-scan queue + quarantine columns + audit table.

-- Pending queue for the deep-scan worker.
CREATE TABLE memories_pending_deep_scan (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id    uuid NOT NULL UNIQUE,
  tenant_id    uuid NOT NULL,
  enqueued_at  timestamptz NOT NULL DEFAULT NOW(),
  claimed_at   timestamptz,
  claimed_by   text
);

CREATE INDEX mpds_unclaimed ON memories_pending_deep_scan (enqueued_at)
  WHERE claimed_at IS NULL;

-- Quarantine marker on memories rows. RLS policy must exclude
-- WHERE dlp_quarantine_at IS NULL on every read.
ALTER TABLE memories
  ADD COLUMN dlp_quarantine_at timestamptz,
  ADD COLUMN dlp_quarantine_reason text;

CREATE INDEX memories_quarantined ON memories (tenant_id)
  WHERE dlp_quarantine_at IS NOT NULL;

-- Audit log of quarantine actions.
CREATE TABLE dlp_quarantine_audit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id     uuid NOT NULL,
  tenant_id     uuid NOT NULL,
  detected_at   timestamptz NOT NULL DEFAULT NOW(),
  detector      text NOT NULL,         -- 'layer1_redactor' | 'layer2_deep_scan'
  finding_kinds text[] NOT NULL,
  llm_response  jsonb
);
