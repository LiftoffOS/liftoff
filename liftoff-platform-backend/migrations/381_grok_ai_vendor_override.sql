-- Admit 'grok' to the per-AI-team vendor override (migration 328).
--
-- 328 wrote the CHECK as an inline list of eight values. A ninth vendor means
-- dropping and re-adding the constraint on BOTH tables — internal_agents AND
-- internal_agent_versions. The versions half is not optional: 328 added it so
-- rollback restores the override, exactly as 167 did for autonomy_override and
-- as 179 had to repair when the versions half was forgotten. A save that passes
-- on the live row and fails on its version snapshot fails the WHOLE save,
-- because the field rides the same PUT as role/responsibilities/skills.
--
-- 328 is NOT edited. pgmigrations records filenames, so editing an applied file
-- runs in no database that already has it while a from-scratch rebuild gets the
-- new text — the two then disagree forever with nothing comparing them. Fix
-- forward, the way 163 and 344 do.
--
-- Constraint names are read from the catalog rather than assumed. 328 declared
-- the CHECK inline with no name, so Postgres generated one; the generated form
-- is predictable but not guaranteed, and a wrong DROP name would abort the
-- whole pending batch and block every deploy queued behind it.
--
-- VARCHAR(20) already accommodates 'grok' (4 chars), so no type change.

DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT rel.relname AS table_name, con.conname AS constraint_name
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE con.contype = 'c'
       AND rel.relname IN ('internal_agents', 'internal_agent_versions')
       AND pg_get_constraintdef(con.oid) ILIKE '%ai_vendor_override%'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', c.table_name, c.constraint_name);
  END LOOP;
END $$;

ALTER TABLE internal_agents
  ADD CONSTRAINT internal_agents_ai_vendor_override_check
    CHECK (ai_vendor_override IN (
      'default', 'anthropic', 'openai', 'google', 'deepseek', 'glm', 'kimi', 'qwen', 'grok'
    ));

ALTER TABLE internal_agent_versions
  ADD CONSTRAINT internal_agent_versions_ai_vendor_override_check
    CHECK (ai_vendor_override IN (
      'default', 'anthropic', 'openai', 'google', 'deepseek', 'glm', 'kimi', 'qwen', 'grok'
    ));
