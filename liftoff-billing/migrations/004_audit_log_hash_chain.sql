-- migrations/004_audit_log_hash_chain.sql
-- Hash-chain BEFORE-INSERT trigger on billing_audit_log.
--
-- On every insert, populate:
--   prev_hash  = previous row's row_hash (by id) or '' for the first row.
--   row_hash   = sha256(
--                   prev_hash
--                   || '|' || id::text
--                   || '|' || tenant_id::text
--                   || '|' || coalesce(actor_user_id, '')
--                   || '|' || action
--                   || '|' || coalesce(target_ref, '')
--                   || '|' || coalesce(payload_json::text, '')
--                   || '|' || extract(epoch from occurred_at)::text
--                )
--
-- The anchor job reads the most recent row's row_hash and
-- publishes it to GCS daily. A tamper check recomputes the chain from
-- any point and compares to the published anchor.

BEGIN;

CREATE OR REPLACE FUNCTION billing_audit_log_fill_hash_chain()
RETURNS trigger AS $$
DECLARE
  prev TEXT;
  concat TEXT;
BEGIN
  -- Look up the previous row's row_hash for the same partition.
  -- Uses occurred_at (the partition key) to scope the lookup and keep
  -- the index seek cheap.
  SELECT row_hash
    INTO prev
    FROM billing_audit_log
    WHERE occurred_at <= NEW.occurred_at
    ORDER BY occurred_at DESC, id DESC
    LIMIT 1;

  NEW.prev_hash := COALESCE(prev, '');
  concat :=
    NEW.prev_hash
    || '|' || COALESCE(NEW.id::text, '')
    || '|' || COALESCE(NEW.tenant_id::text, '')
    || '|' || COALESCE(NEW.actor_user_id, '')
    || '|' || COALESCE(NEW.action, '')
    || '|' || COALESCE(NEW.target_ref, '')
    || '|' || COALESCE(NEW.payload_json::text, '')
    || '|' || EXTRACT(EPOCH FROM NEW.occurred_at)::text;

  NEW.row_hash := encode(digest(concat, 'sha256'), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Requires pgcrypto for digest().
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CASCADE drops partition triggers that PG 12+ auto-propagated from the parent.
-- Without CASCADE, dropping a partition-owned trigger independently fails (2BP01).
DROP TRIGGER IF EXISTS billing_audit_log_fill_hash_chain ON billing_audit_log CASCADE;
CREATE TRIGGER billing_audit_log_fill_hash_chain
  BEFORE INSERT ON billing_audit_log
  FOR EACH ROW
  EXECUTE FUNCTION billing_audit_log_fill_hash_chain();

-- PG 12+ auto-propagates the parent trigger to existing partitions, so the
-- CREATE below is a no-op on modern Postgres. On PG 11 it installs the trigger.
-- EXCEPTION WHEN duplicate_object handles the PG 12+ case silently.
DO $$ DECLARE part TEXT;
BEGIN
  FOR part IN
    SELECT inhrelid::regclass::text
    FROM pg_inherits
    WHERE inhparent = 'billing_audit_log'::regclass
  LOOP
    BEGIN
      EXECUTE format(
        'CREATE TRIGGER billing_audit_log_fill_hash_chain
           BEFORE INSERT ON %s
           FOR EACH ROW
           EXECUTE FUNCTION billing_audit_log_fill_hash_chain()',
        part
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $$;

-- A helper that verifies the chain integrity of a partition; used by
-- the audit-anchor-job pre-publish integrity check.
CREATE OR REPLACE FUNCTION billing_audit_log_verify_chain(partition_name TEXT)
RETURNS TABLE(row_id BIGINT, ok BOOLEAN) AS $$
DECLARE
  rec RECORD;
  prev TEXT := '';
  expected TEXT;
  concat TEXT;
BEGIN
  FOR rec IN EXECUTE format('SELECT id, tenant_id, actor_user_id, action, target_ref, payload_json, occurred_at, prev_hash, row_hash FROM %I ORDER BY occurred_at, id', partition_name)
  LOOP
    concat :=
      prev
      || '|' || COALESCE(rec.id::text, '')
      || '|' || COALESCE(rec.tenant_id::text, '')
      || '|' || COALESCE(rec.actor_user_id, '')
      || '|' || COALESCE(rec.action, '')
      || '|' || COALESCE(rec.target_ref, '')
      || '|' || COALESCE(rec.payload_json::text, '')
      || '|' || EXTRACT(EPOCH FROM rec.occurred_at)::text;
    expected := encode(digest(concat, 'sha256'), 'hex');
    row_id := rec.id;
    ok := (rec.prev_hash = prev AND rec.row_hash = expected);
    RETURN NEXT;
    prev := rec.row_hash;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMIT;
