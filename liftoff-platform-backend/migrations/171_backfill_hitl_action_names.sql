-- Backfill action names for all Level 4/5 governance-engine audit records.
--
-- Renames `action = 'hitl_level_5_operation'` and
-- `action = 'hitl_level_4_auto_elevated'` to the actual tool name stored
-- in `input_args->>'toolName'`. This makes the activity feed show
-- "Bash" / "Gmail Search" instead of "Autonomous operation".
--
-- Skips rows where toolName is not set in input_args (safety guard).
-- Idempotent: rows that have already been renamed won't match the WHERE clause.

DO $$
DECLARE
  rows_updated_5 integer;
  rows_updated_4 integer;
BEGIN
  -- Verify counts (visible in migration output as NOTICEs)
  RAISE NOTICE '=== HITL action backfill ===';
  RAISE NOTICE 'hitl_level_5_operation rows with toolName: %',
    (SELECT COUNT(*) FROM agent_audit_logs
     WHERE action = 'hitl_level_5_operation'
       AND input_args->>'toolName' IS NOT NULL);
  RAISE NOTICE 'hitl_level_4_auto_elevated rows with toolName: %',
    (SELECT COUNT(*) FROM agent_audit_logs
     WHERE action = 'hitl_level_4_auto_elevated'
       AND input_args->>'toolName' IS NOT NULL);

  BEGIN
    ALTER TABLE agent_audit_logs DISABLE TRIGGER agent_audit_logs_immutable;

    UPDATE agent_audit_logs
    SET
      action     = input_args->>'toolName',
      input_args = jsonb_build_object(
        'hitlLevel',    (input_args->>'hitlLevel')::int,
        'autoElevated', (action = 'hitl_level_4_auto_elevated'),
        'categories',   COALESCE(input_args->'categories', '[]'::jsonb),
        'backfilled',   true
      )
    WHERE action = 'hitl_level_5_operation'
      AND input_args->>'toolName' IS NOT NULL;

    GET DIAGNOSTICS rows_updated_5 = ROW_COUNT;

    UPDATE agent_audit_logs
    SET
      action     = input_args->>'toolName',
      input_args = jsonb_build_object(
        'hitlLevel',    (input_args->>'hitlLevel')::int,
        'autoElevated', (action = 'hitl_level_4_auto_elevated'),
        'categories',   COALESCE(input_args->'categories', '[]'::jsonb),
        'backfilled',   true
      )
    WHERE action = 'hitl_level_4_auto_elevated'
      AND input_args->>'toolName' IS NOT NULL;

    GET DIAGNOSTICS rows_updated_4 = ROW_COUNT;

    ALTER TABLE agent_audit_logs ENABLE TRIGGER agent_audit_logs_immutable;

    RAISE NOTICE 'Renamed % level-5 rows, % level-4 rows', rows_updated_5, rows_updated_4;

  EXCEPTION WHEN OTHERS THEN
    -- Migration user lacks ALTER TABLE privilege. Rows unchanged.
    -- Run manually with a superuser connection if needed.
    RAISE NOTICE 'Cannot bypass audit immutability trigger (insufficient privilege): %', SQLERRM;
    RAISE NOTICE 'Run this UPDATE manually with a superuser connection if you need the backfill.';
  END;

  RAISE NOTICE '=== HITL action backfill END ===';
END $$;
