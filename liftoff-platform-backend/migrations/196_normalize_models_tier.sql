-- Migration 196: Normalize models.tier from 'large' to 'flagship'
--
-- Migration 187 added the tier column with an anonymous CHECK constraint:
--   ALTER TABLE models ADD COLUMN IF NOT EXISTS tier TEXT CHECK (tier IN ('small', 'medium', 'large'));
-- PostgreSQL auto-named it (typically 'models_tier_check' but not guaranteed).
-- Use the pg_constraint lookup pattern (matches migration 089) so this works
-- regardless of the actual constraint name. The IF EXISTS form would silently
-- fail to drop and leave a constraint that rejects 'flagship' updates.

BEGIN;

DO $$
DECLARE
  check_name TEXT;
BEGIN
  FOR check_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'models'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%tier%'
  LOOP
    EXECUTE format('ALTER TABLE models DROP CONSTRAINT %I', check_name);
  END LOOP;
END $$;

UPDATE models SET tier = 'flagship' WHERE tier = 'large';

ALTER TABLE models ADD CONSTRAINT models_tier_check
  CHECK (tier IN ('flagship', 'medium', 'small'));

COMMIT;
