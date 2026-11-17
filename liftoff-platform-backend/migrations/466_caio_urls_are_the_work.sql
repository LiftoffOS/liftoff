-- Migration 466: the address of a page is part of the work, not of the mechanics.
--
-- Rule 4 of "Building from work already done" tells the Chief AI Officer never
-- to say "how a site is reached", meaning by a browser or by a page read. Read
-- beside the instruction to carry exact URLs, that phrase was taken as the
-- address itself, and a brief came out saying "the usual reference URL" for
-- two pages the person had named — which no team can open. The rule now says
-- what it means, and says the address is written exactly as the person gave it.
--
-- PROMPT COPY FLAGGED FOR OPERATOR REVIEW before this migration ships.
--
-- Same mechanics as 462–465: targeted replace() against the exact sentence the
-- prompt carries, verified to land exactly once, inside the NO FORCE / FORCE
-- fence scripts/ci-fences/system-agent-rls-fence.sh requires.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

UPDATE internal_agents
SET system_prompt = replace(
      system_prompt,
      $ANCHOR$Never say how the platform does the work — which tool reads a page, whether a run uses a browser or a session, how a site is reached, or any tool or vendor name. Execution is decided when the team is built, from what the platform offers then; a scheduled run is kept away from anything that needs a person present without being told.$ANCHOR$,
      $NEW$Never say how the platform does the work — which tool reads a page, whether a run uses a browser or a session, whether a site is reached by a browser or by a page read, or any tool or vendor name. The address of a page the team opens is part of the work, not of the mechanics: write every URL exactly as the person gave it, never "the usual page" or "the reference URL". Execution is decided when the team is built, from what the platform offers then; a scheduled run is kept away from anything that needs a person present without being told.$NEW$
    ),
    updated_at = NOW()
WHERE system_role = 'caio'
  AND is_system = TRUE;

DO $verify$
DECLARE
  section_count integer;
BEGIN
  SELECT (length(system_prompt) - length(replace(system_prompt, 'write every URL exactly as the person gave it', '')))
         / length('write every URL exactly as the person gave it')
    INTO section_count
  FROM internal_agents
  WHERE system_role = 'caio' AND is_system = TRUE;
  IF section_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 466: expected exactly one URL instruction, found %', section_count;
  END IF;
END
$verify$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
