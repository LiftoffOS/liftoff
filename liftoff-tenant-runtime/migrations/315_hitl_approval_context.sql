-- Approval requests carry free-form provenance so the /review card can show why a
-- call was gated — e.g. that external-authored content initiated the run, plus the
-- injection screen's shadow verdict when one was produced.
ALTER TABLE hitl_approval_requests ADD COLUMN IF NOT EXISTS context JSONB;

COMMENT ON COLUMN hitl_approval_requests.context IS
  'Provenance attached at creation, e.g. { origin: external_content, screenVerdict }.';
