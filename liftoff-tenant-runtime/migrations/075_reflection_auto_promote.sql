-- Widen reflection_suggestions status to include 'auto-promoted'.
-- Idempotent: handles both cases (named constraint exists, or no constraint exists).

DO $$
BEGIN
  ALTER TABLE reflection_suggestions
    ADD CONSTRAINT reflection_suggestions_status_check
    CHECK (status IN ('pending', 'accepted', 'rejected', 'auto-promoted'));
EXCEPTION WHEN duplicate_object THEN
  ALTER TABLE reflection_suggestions DROP CONSTRAINT reflection_suggestions_status_check;
  ALTER TABLE reflection_suggestions
    ADD CONSTRAINT reflection_suggestions_status_check
    CHECK (status IN ('pending', 'accepted', 'rejected', 'auto-promoted'));
END $$;
