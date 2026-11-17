-- Migration 545: the Chief AI Officer stops explaining what removing an AI team
-- keeps, because there is nothing to explain.
--
-- Archiving is the removal action and no delete sits behind it, but no prompt
-- said so, so a model asked to delete reasoned from first principles and
-- produced a lecture: asked to delete an AI team, it could answer with an
-- account of what archiving preserves and a fresh question, instead of the
-- removal the person had asked for.
--
-- The distinction is ours and not theirs: it is a detail of how a row is stored.
-- The rule is one paragraph, the same words the other two assistants import
-- (src/shared/removing-an-ai-team.ts), inserted before the voice block exactly
-- as they insert it. Pinned by scripts/__tests__/caio-removal-rule-sync.test.ts,
-- which is the only thing that can read a prompt living in a database.
--
-- A targeted insert, in the shape of 497 rather than 509: an anchor asserted to
-- occur exactly once, replaced with itself preceded by the new paragraph, and
-- verified after. `## Voice` is that anchor.
--
-- RLS: as 482, 484, 488, 496, 497, 509, 512, 515 and 544; required by
-- scripts/ci-fences/system-agent-rls-fence.sh.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

DO $before$
DECLARE
  prompt text;
  n integer;
BEGIN
  SELECT system_prompt INTO prompt FROM internal_agents WHERE system_role = 'caio' AND is_system = TRUE;
  IF prompt IS NULL THEN
    RAISE EXCEPTION 'migration 545: no Chief AI Officer system row';
  END IF;
  n := (length(prompt) - length(replace(prompt, '## Voice', ''))) / length('## Voice');
  IF n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 545: expected exactly one voice heading to insert before, found %', n;
  END IF;
  n := (length(prompt) - length(replace(prompt, 'Removing an AI team has one name here', ''))) / length('Removing an AI team has one name here');
  IF n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'migration 545: the removal rule is already present % times', n;
  END IF;
END
$before$;

UPDATE internal_agents
SET system_prompt = replace(
      system_prompt,
      $OLD$## Voice$OLD$,
      $Hn$## Removing An AI Team
Removing an AI team has one name here. "Delete", "remove", "get rid of" and "archive" all mean the same single action, and there is no second, more permanent one behind it. Treat a request for any of them as the request it is and get on with it: make the change where it is yours to make, and otherwise hand it to the Chief AI Officer in the person's own words. Never set those words against each other, never explain what removing an AI team does or does not keep, and never ask the person to accept a distinction before anything happens. If they ask whether a removed AI team is really gone, the answer is that it is removed from their workspace, and then you act.

## Voice$Hn$),
    updated_at = NOW()
WHERE system_role = 'caio'
  AND is_system = TRUE;

DO $verify$
DECLARE
  prompt text;
  n integer;
BEGIN
  SELECT system_prompt INTO prompt FROM internal_agents WHERE system_role = 'caio' AND is_system = TRUE;
  n := (length(prompt) - length(replace(prompt, 'Removing an AI team has one name here', ''))) / length('Removing an AI team has one name here');
  IF n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 545: expected exactly one removal rule after the insert, found %', n;
  END IF;
  -- The anchor is still there once, which is what says the replace inserted
  -- rather than duplicated the section that follows it.
  n := (length(prompt) - length(replace(prompt, '## Voice', ''))) / length('## Voice');
  IF n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 545: expected the voice heading to survive exactly once, found %', n;
  END IF;
  n := (length(prompt) - length(replace(prompt, 'never explain what removing an AI team does or does not keep', ''))) / length('never explain what removing an AI team does or does not keep');
  IF n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 545: expected exactly one no-explanation sentence, found %', n;
  END IF;
END
$verify$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
