-- Files that belong to a skill.
--
-- A skill used to be one block of text, which is half of what the SKILL.md
-- convention is: a directory holding SKILL.md plus `scripts/`, `references/`
-- and `examples/`. Without the files, an imported skill describes tools that
-- are not there, and the model reads instructions for a script it cannot run.
--
-- POINTERS ONLY. Content lives in the control plane's generated-files bucket,
-- content-addressed by its own sha256, and is fetched and materialized into the
-- sandbox for the run that needs it. Storing content here would put the same
-- bytes in every tenant database and give the runtime a second copy to keep in
-- step with the platform column, which is authoritative (ADR-043).
--
-- Shape, mirroring the control plane's SkillBundle:
--   { "files": [ { "path", "bytes", "sha256", "storageRef", "executable"? } ] }
--
-- Nullable, with no default: the overwhelming majority of skills have no files,
-- and NULL says "this skill ships no files" without storing an empty object per
-- row.

ALTER TABLE agent_skills
  ADD COLUMN IF NOT EXISTS bundle JSONB;

COMMENT ON COLUMN agent_skills.bundle IS
  'Pointers to the files this skill ships with (path, bytes, sha256, storageRef). Content lives in the control plane bucket and is materialized read-only into the sandbox per run. NULL means the skill ships no files.';
