-- child_tasks.parent_task_id/workflow_id are NOT-NULL FKs to workflow_tasks/workflows,
-- but normal agent runs never create those rows → INSERT is impossible today.
-- Drop the FKs by column (name-agnostic) and relax workflow_id. parent_task_id stays
-- the per-graph grouping key (a free UUID after this).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
    WHERE rel.relname = 'child_tasks' AND con.contype = 'f'
      AND att.attname IN ('parent_task_id', 'workflow_id')
  LOOP
    EXECUTE format('ALTER TABLE child_tasks DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE child_tasks ALTER COLUMN workflow_id DROP NOT NULL;

-- workflow_task_dependencies.task_id/depends_on_task_id are FKs to workflow_tasks(id),
-- but the DAG executor stores CHILD-TASK edges here (task_id/depends_on_task_id both
-- reference child_tasks.id). With the FKs still pointing at workflow_tasks, every
-- insertTaskDependency() throws a foreign-key violation. Drop those two FKs the same
-- name-agnostic way; the uq_workflow_task_dependencies UNIQUE (migration 209) stays so
-- ON CONFLICT DO NOTHING keeps working.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
    WHERE rel.relname = 'workflow_task_dependencies' AND con.contype = 'f'
      AND att.attname IN ('task_id', 'depends_on_task_id')
  LOOP
    EXECUTE format('ALTER TABLE workflow_task_dependencies DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
