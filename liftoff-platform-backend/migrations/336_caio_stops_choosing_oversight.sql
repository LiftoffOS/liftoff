-- The Chief AI Officer must not choose an oversight level.
--
-- Its seed prompt carried a "## HITL level guidance" section describing four
-- levels, their semantics, and which is "default for new AI teams". The CAIO
-- read that as an instruction to pick one, and told people things like "I'll
-- start it at the standard oversight level, destructive actions gated, routine
-- writes proceed freely" — as a configuration choice it had made.
--
-- It had made nothing. There is no oversight or autonomy field on a workforce
-- plan spec, teambuilder__create does not send one, and every agent it has
-- provisioned has internal_agents.autonomy_override IS NULL, which is what
-- makes an agent follow the workspace default. The behaviour was always
-- correct; only the narration was invented, which is worse than saying nothing
-- because it reads like a governance decision the operator can rely on.
--
-- Replaced with an instruction to defer to the workspace default and to say so
-- plainly if asked. Nothing else in the prompt changes.
--
-- The regexp cuts from the heading to the start of the next section, so the
-- surrounding prompt is untouched regardless of what follows it.

-- System agents carry tenant_id IS NULL, so no tenant policy can reach this
-- row. Required by scripts/ci-fences/system-agent-rls-fence.sh.
ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

UPDATE internal_agents
SET system_prompt = regexp_replace(
      system_prompt,
      '## HITL level guidance.*?(?=\n## |$)',
      '## Oversight' || chr(10) ||
      'New AI teams follow the workspace oversight default. Do not choose an oversight or HITL level, do not tell the user which level a team will run at, and do not describe what a level permits. If oversight comes up, say the team follows the workspace default and point to the governance controls.' || chr(10) || chr(10)
    ),
    updated_at = NOW()
WHERE system_role = 'caio'
  AND system_prompt LIKE '%HITL level guidance%';

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;
