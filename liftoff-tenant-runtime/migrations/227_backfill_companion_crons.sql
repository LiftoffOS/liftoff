-- 223: backfill singular companionCron → plural companionCrons array.
-- (Plan numbered 222; renumbered to 223 to keep monotonic order after
--  221_invocation_triggered_by_label.sql and 222_reactive_subscriptions.sql.)
--
-- Ships only AFTER multi-companion crons is live for >=1 release cycle (no more producers
-- emit the singular form). Loader normalizes both shapes at read time so this
-- migration is purely cleanup; no application behavior depends on it running.

UPDATE agents
SET trigger_config = (
  trigger_config
    - 'companionCron'
    || jsonb_build_object(
      'companionCrons',
      jsonb_build_array(
        jsonb_build_object(
          'label', 'default',
          'cronExpr', trigger_config->'companionCron'->>'cronExpr',
          'timezone', trigger_config->'companionCron'->>'timezone'
        )
      )
    )
)
WHERE trigger_config ? 'companionCron'
  AND NOT (trigger_config ? 'companionCrons');
