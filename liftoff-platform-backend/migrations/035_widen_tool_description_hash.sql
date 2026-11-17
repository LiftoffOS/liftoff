-- Migration 035: Widen tool_description_hash from CHAR(12) to TEXT.
--
-- Migration 028 created this column as CHAR(12) for MD5-truncated hashes.
-- Migrations 082 and 084 seed marker strings longer than that
-- ('vendor_seed_v1', 'mcp_seed_v1'), so on a FRESH database they fail with
-- 22001 unless this runs first.
--
-- WAS 083a, AND THAT IS WHY IT NEVER WORKED. node-pg-migrate orders by
-- `getNumericPrefix`: the text before the first underscore, and when that is
-- not purely numeric it returns `Number(prefix) || 0`. '083a' parses to NaN,
-- falls to 0, and sorted BEFORE 001_initial_schema — so it ran before migration
-- 028 had created the table, its guard found no column, and it silently
-- no-opped. The fix for fresh databases had never once executed on one.
--
-- 035 is one of only two free slots between 028 and 084 (the other is 038), so
-- it lands after the column exists and before anything seeds it. The number
-- matters here; the name does not.
--
-- Safe to re-run: the guard no-ops where the column is already TEXT, which is
-- every database that has been through the old 083a path.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'tool_classification_cache'
        AND column_name = 'tool_description_hash') = 'character' THEN
    ALTER TABLE tool_classification_cache
      ALTER COLUMN tool_description_hash TYPE TEXT;
  END IF;
END $$;
