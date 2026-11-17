-- Batched TTL backfill — 1000 rows per iteration to avoid table-wide locks.
-- Separate from 072 DDL so the column additions are fast (metadata-only in PG 11+).

DO $$
DECLARE
  batch_size INT := 1000;
  rows_updated INT;
BEGIN
  -- 90-day TTL for non-correction memories
  LOOP
    UPDATE memories SET expires_at = NOW() + INTERVAL '90 days'
    WHERE id IN (
      SELECT id FROM memories
      WHERE expires_at IS NULL AND superseded_by IS NULL
        AND NOT tags @> ARRAY['correction']
      LIMIT batch_size
      FOR UPDATE SKIP LOCKED
    );
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    EXIT WHEN rows_updated = 0;
    PERFORM pg_sleep(0.1);
  END LOOP;

  -- 180-day TTL for correction memories
  LOOP
    UPDATE memories SET expires_at = NOW() + INTERVAL '180 days'
    WHERE id IN (
      SELECT id FROM memories
      WHERE expires_at IS NULL AND superseded_by IS NULL
        AND tags @> ARRAY['correction']
      LIMIT batch_size
      FOR UPDATE SKIP LOCKED
    );
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    EXIT WHEN rows_updated = 0;
    PERFORM pg_sleep(0.1);
  END LOOP;
END $$;
