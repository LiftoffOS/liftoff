-- Agent skill provenance (P1.0 — Hermes lift).
--
-- Skills have two authors: the distiller (every create / Optimize / redistill)
-- and the reflection flywheel plus operator edits. Until now the runtime had no
-- way to tell them apart, and neither did the control plane — so a redistill
-- replaced the whole set and silently discarded everything the team member had
-- learned. The control plane now merges by provenance before publishing; these
-- columns carry that decision into the runtime so it is visible where the
-- skills are actually retrieved and scored.
--
-- provenance:
--   'distilled' — authored by the distiller (default for every legacy row:
--                 before the flywheel wrote back to the platform column, the
--                 distiller was the only writer whose output survived)
--   'learned'   — authored by the reflection flywheel
--   'operator'  — authored, edited, or imported by a human
--
-- protected: an operator took ownership; the flywheel may not refine it or
-- merge into it. Enforced control-plane side (skill-feedback-service), mirrored
-- here so the state is inspectable from the runtime.

ALTER TABLE agent_skills
  ADD COLUMN IF NOT EXISTS provenance TEXT NOT NULL DEFAULT 'distilled',
  ADD COLUMN IF NOT EXISTS protected  BOOLEAN NOT NULL DEFAULT false;

-- Constrained rather than free text: an unknown provenance would silently opt a
-- skill out of every merge rule that reads it.
ALTER TABLE agent_skills
  DROP CONSTRAINT IF EXISTS agent_skills_provenance_check;
ALTER TABLE agent_skills
  ADD CONSTRAINT agent_skills_provenance_check
  CHECK (provenance IN ('distilled', 'learned', 'operator'));

COMMENT ON COLUMN agent_skills.provenance IS
  'Who authored this skill: distilled (distiller) | learned (reflection flywheel) | operator (human edit/import). Drives the control-plane merge that keeps a redistill from discarding learned skills.';
COMMENT ON COLUMN agent_skills.protected IS
  'Operator-owned: the reflection flywheel may not refine this skill or merge into it.';
