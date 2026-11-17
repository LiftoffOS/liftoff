\echo === Code Reviewer trigger reasoning AFTER my redistill (v39) ===
SELECT trigger_config->>'type' AS type, trigger_config->>'cronExpr' AS cron,
       left(trigger_config->>'reasoning', 400) AS reasoning
  FROM internal_agents WHERE id='5c117117-b6ab-4f11-9c7f-e1b8ed2ada3f';
