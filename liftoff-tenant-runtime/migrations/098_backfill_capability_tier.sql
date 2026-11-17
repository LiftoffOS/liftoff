-- Backfill capability_tier for existing compiled_instructions rows.
--
-- Two sources of truth:
-- 1. Agents whose compiled system_prompt/user_instructions reference sandbox__ tools
--    (distilled after sandbox detection was added).
-- 2. Agents whose role contains coding keywords (distilled before sandbox detection,
--    e.g. an agent named "Coder").

UPDATE compiled_instructions ci
SET capability_tier = 'execution_enabled'
WHERE capability_tier = 'connector_only'
  AND (
    -- Source 1: prompt already contains sandbox markers
    (ci.system_prompt || ' ' || COALESCE(ci.user_instructions, '')) LIKE '%sandbox__%'
    OR
    -- Source 2: agent role/name is coding-related
    EXISTS (
      SELECT 1 FROM agents a
      WHERE a.id = ci.agent_id
        AND (
          lower(a.name) SIMILAR TO '%(coder|developer|engineer|programmer|devops|sre|software|code review|git|bash|shell)%'
          OR lower(COALESCE(a.role, '')) SIMILAR TO '%(coder|developer|engineer|programmer|devops|sre|software|code review|git|bash|shell)%'
        )
    )
  );
