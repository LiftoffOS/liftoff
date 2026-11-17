-- Migration 464: the brief the Chief AI Officer writes is the person's layer.
--
-- The four inputs the CAIO hands the HRBP — role, responsibilities,
-- integrations, additional context — are what the team's page shows and what
-- a person edits; the build turns them into the technical layer (the
-- instructions and the workflow steps), which is where a tool name belongs.
-- Nothing told the CAIO that. Its rules said never to expose tool names in a
-- REPLY, and never to name a browser product, so it wrote "use the direct
-- web-reading tool, not an interactive browser session" into a team's
-- "Anything to avoid" — the same mechanic in plain clothes, in the one text a
-- person reads, about a distinction the platform already makes on its own for
-- a scheduled run. Workforce-service now refuses a draft or an edit whose
-- prose names execution mechanics; this states the rule where the CAIO is
-- told to carry the work into the brief, so the refusal is rarely reached.
--
-- PROMPT COPY FLAGGED FOR OPERATOR REVIEW before this migration ships.
--
-- Same mechanics as 462/463: targeted replace() against exact sentences the
-- prompt carries, each verified to have landed exactly once, inside the
-- NO FORCE / FORCE fence scripts/ci-fences/system-agent-rls-fence.sh requires.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

-- The list for work done with Liftoff (source conversation).
UPDATE internal_agents
SET system_prompt = replace(
      system_prompt,
      $ANCHOR$4. Browser steps in the trail are material for the workflows section. Describe browser work by its steps, URLs and identity names, never by a browser product name.$ANCHOR$,
      $NEW$4. Browser steps in the trail are material for the workflows section. Describe browser work by its steps, URLs and identity names, never by a browser product name. The brief is the person's layer: it is what the team's page shows and what they edit, so write what the team does, for whom, when, with what rules and limits, and what the result looks like. Never say how the platform does the work — which tool reads a page, whether a run uses a browser or a session, how a site is reached, or any tool or vendor name. Execution is decided when the team is built, from what the platform offers then; a scheduled run is kept away from anything that needs a person present without being told.$NEW$
    ),
    updated_at = NOW()
WHERE system_role = 'caio'
  AND is_system = TRUE;

-- The list for work done with the CAIO itself.
UPDATE internal_agents
SET system_prompt = replace(
      system_prompt,
      $ANCHOR$4. Describe browser steps by their URLs, identity names and actions, never by a browser product name, and a capability by what it does, never by the vendor behind it.$ANCHOR$,
      $NEW$4. Describe browser steps by their URLs, identity names and actions, never by a browser product name, and a capability by what it does, never by the vendor behind it. The same rule as above holds for every field of the brief: the person's terms, never the platform's mechanics. A steering you gave yourself during the work — "read the page directly", "not the browser" — is not a rule for the team; leave it out.$NEW$
    ),
    updated_at = NOW()
WHERE system_role = 'caio'
  AND is_system = TRUE;

DO $verify$
DECLARE
  first_count integer;
  second_count integer;
BEGIN
  SELECT (length(system_prompt) - length(replace(system_prompt, 'The brief is the person''s layer', '')))
         / length('The brief is the person''s layer')
    INTO first_count
  FROM internal_agents
  WHERE system_role = 'caio' AND is_system = TRUE;
  IF first_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 464: expected exactly one "The brief is the person''s layer" instruction, found %', first_count;
  END IF;

  SELECT (length(system_prompt) - length(replace(system_prompt, 'is not a rule for the team; leave it out', '')))
         / length('is not a rule for the team; leave it out')
    INTO second_count
  FROM internal_agents
  WHERE system_role = 'caio' AND is_system = TRUE;
  IF second_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 464: expected exactly one "is not a rule for the team" instruction, found %', second_count;
  END IF;
END
$verify$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
