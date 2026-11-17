-- A7 — autonomy-advisor proposals ride the existing reflection_suggestions table.
--
-- `kind` distinguishes the classic instruction-edit suggestion (default, unchanged behavior)
-- from an 'autonomy' proposal (loosen/tighten a HITL policy or hitl level). `action_payload`
-- carries the typed AutonomyAction for autonomy rows (null for instruction rows). The applier
-- routes on `kind`; autonomy rows are never auto-applied (human review only).
ALTER TABLE reflection_suggestions
  ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'instruction',
  ADD COLUMN IF NOT EXISTS action_payload JSONB;

CREATE INDEX IF NOT EXISTS idx_reflection_suggestions_kind
  ON reflection_suggestions (agent_id, kind, status);
