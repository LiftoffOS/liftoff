-- migrations/128_role_graduation_and_peer_window.sql

-- 1. Allow tenant-scoped (no agent_id) entries in the existing audit table.
ALTER TABLE instruction_amendment_audit ALTER COLUMN agent_id DROP NOT NULL;
COMMENT ON COLUMN instruction_amendment_audit.agent_id IS
  'NULL for tenant-scoped amendments like role_graduation.';

-- 2. Per-(tenant, role) source-of-truth for graduated content.
CREATE TABLE IF NOT EXISTS learned_role_instructions (
  tenant_id  UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role       TEXT         NOT NULL,
  content_md TEXT         NOT NULL DEFAULT '',
  source_memory_ids UUID[] NOT NULL DEFAULT '{}',
  last_amendment_audit_id UUID,
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, role)
);

-- 3. Append-only history: "what did role X know on date Y?"
CREATE TABLE IF NOT EXISTS learned_role_instructions_history (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID         NOT NULL,
  role       TEXT         NOT NULL,
  content_md TEXT         NOT NULL,
  source_memory_ids UUID[] NOT NULL,
  amendment_audit_id UUID,
  effective_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lri_history_role
  ON learned_role_instructions_history(tenant_id, role, effective_at DESC);

-- 4. Peer-window query index (partial, partition-aware).
CREATE INDEX IF NOT EXISTS idx_memories_peer_window
  ON memories(tenant_id, layer, created_at DESC)
  WHERE layer IN ('role', 'global')
    AND superseded_by IS NULL
    AND graduated_at IS NULL;

-- 5. Bootstrap: seed harvest:high-confidence memories so peer-window has
--    candidates on day 1. No-op until harvest-side tagging ships (Change A.6).
UPDATE memories
SET usefulness_score = GREATEST(usefulness_score, 2)
WHERE layer IN ('role', 'global')
  AND tags @> ARRAY['harvest:high-confidence']
  AND superseded_by IS NULL
  AND usefulness_score < 2;
