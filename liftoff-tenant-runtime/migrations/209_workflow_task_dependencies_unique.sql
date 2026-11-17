-- migrations/209_workflow_task_dependencies_unique.sql
--
-- (1) workflow_task_dependencies needs a unique constraint so the DAG
--     executor can use ON CONFLICT DO NOTHING when persisting edges.
-- (2) child_tasks.agent_id is currently NOT NULL but the code doesn't insert
--     it; migration 011 intended to drop this constraint but the ALTER was
--     missing. Fix that here and repurpose the column as the executor agent
--     (NULL = inherit from parent agent, set = specialist routing).

DELETE FROM workflow_task_dependencies a
USING workflow_task_dependencies b
WHERE a.id > b.id
  AND a.task_id = b.task_id
  AND a.depends_on_task_id = b.depends_on_task_id;

ALTER TABLE workflow_task_dependencies
  ADD CONSTRAINT uq_workflow_task_dependencies
  UNIQUE (task_id, depends_on_task_id);

ALTER TABLE child_tasks
  ALTER COLUMN agent_id DROP NOT NULL;

COMMENT ON COLUMN child_tasks.agent_id IS
  'Specialist agent assigned to execute this child task. NULL = inherit from parent agent. Set by spawn_task_graph TaskNode.executorAgentId, used by dispatcher for specialist routing (same semantic as delegate_to_agent but async/DAG-aware).';
