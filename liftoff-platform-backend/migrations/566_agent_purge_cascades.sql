-- Let a soft-deleted agent actually be purged.
--
-- Deletion of an AI team writes `internal_agents.deleted_at` and nothing ever
-- removed the row, so the definition, its prompts, every version snapshot and
-- the conversations it took part in stayed in the database indefinitely. The
-- purge pass added alongside this migration hard-deletes rows whose grace
-- period has expired, and seven foreign keys would abort that DELETE: they
-- reference internal_agents(id) with no ON DELETE action, which is the default
-- NO ACTION and therefore a hard block rather than a cascade.
--
-- Nine other references to internal_agents(id) already cascade, which is what
-- makes these seven an inconsistency rather than a policy. agent_audit_logs
-- deliberately keeps ON DELETE SET NULL: an audit row outliving the thing it
-- describes is the point of an audit row, and it holds no agent content once
-- the reference is null.
--
-- Idempotent and name-agnostic: the constraint names are whatever Postgres
-- generated years ago, possibly differing between a rebuilt database and a
-- migrated one, so each is found in the catalog by (table, column, referenced
-- table) rather than assumed to be <table>_<column>_fkey.

DO $$
DECLARE
  target   RECORD;
  con_name TEXT;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('agent_chat_thread_participants', 'agent_id'),
      ('agent_chat_messages',            'agent_id'),
      ('agent_slack_apps',               'agent_id'),
      ('agent_slack_installs',           'agent_id'),
      ('workflow_step_executions',       'agent_id'),
      ('chat_share_links',               'agent_id'),
      ('notification_links',             'agent_id')
    ) AS t(tbl, col)
  LOOP
    -- Skip anything this database does not have: the estate has tables that
    -- arrived in later migrations and a from-scratch rebuild runs this file in
    -- the same order, so a missing table is a legitimate state, not an error.
    IF to_regclass(target.tbl) IS NULL THEN
      RAISE NOTICE 'purge-cascade: % absent, skipping', target.tbl;
      CONTINUE;
    END IF;

    SELECT con.conname INTO con_name
      FROM pg_constraint con
      JOIN pg_class child  ON child.oid  = con.conrelid
      JOIN pg_class parent ON parent.oid = con.confrelid
      JOIN pg_attribute att ON att.attrelid = con.conrelid
                           AND att.attnum = con.conkey[1]
     WHERE con.contype = 'f'
       AND child.relname  = target.tbl
       AND parent.relname = 'internal_agents'
       AND att.attname    = target.col
       AND array_length(con.conkey, 1) = 1
     LIMIT 1;

    IF con_name IS NULL THEN
      RAISE NOTICE 'purge-cascade: no single-column FK on %.% -> internal_agents, skipping',
        target.tbl, target.col;
      CONTINUE;
    END IF;

    -- Already cascading? Leave it alone, so a re-run changes nothing.
    IF EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = con_name
         AND conrelid = to_regclass(target.tbl)
         AND confdeltype = 'c'
    ) THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', target.tbl, con_name);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES internal_agents(id) ON DELETE CASCADE',
      target.tbl, con_name, target.col
    );
    RAISE NOTICE 'purge-cascade: %.% now cascades', target.tbl, target.col;
  END LOOP;
END $$;
