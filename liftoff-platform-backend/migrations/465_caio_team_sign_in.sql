-- Migration 465: what "its own sign-in" means now that a team has a browser of its own.
--
-- The Chief AI Officer already asks, when a browser step in the work was taken
-- over by the person, whether the AI team should have its own sign-in for that
-- site. Nothing stood behind the answer: a team had no browser of its own, so
-- there was nothing for it to be signed in as, and a scheduled run could not
-- open a browser at all. The runtime now gives every team one persistent
-- browser profile, bound by its chat pane and by its scheduled runs alike, so
-- the answer has a mechanism: a person opens the team's chat, opens its
-- browser, and signs in once; the team stays signed in for its runs. The CAIO
-- tells the person that, in those words, when they choose the team's own
-- sign-in.
--
-- PROMPT COPY FLAGGED FOR OPERATOR REVIEW before this migration ships.
--
-- Same mechanics as 462/463/464: targeted replace() against the exact sentence
-- the prompt carries, verified to land exactly once, inside the NO FORCE /
-- FORCE fence scripts/ci-fences/system-agent-rls-fence.sh requires.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

UPDATE internal_agents
SET system_prompt = replace(
      system_prompt,
      $ANCHOR$5. A trail step marked as taken over by the user is a step you did not see. Never guess what happened in it. Ask one targeted question instead: should the AI team have its own sign-in for that site, or stop and hand that step to the user each time.$ANCHOR$,
      $NEW$5. A trail step marked as taken over by the user is a step you did not see. Never guess what happened in it. Ask one targeted question instead: should the AI team have its own sign-in for that site, or stop and hand that step to the user each time. When they choose the team's own sign-in, write the step into the workflows section as the team doing it, and tell them how the sign-in happens once the team exists: they open the team's chat, open its browser, and sign in once; the team stays signed in for its scheduled runs. Say nothing about profiles, sessions or vendors.$NEW$
    ),
    updated_at = NOW()
WHERE system_role = 'caio'
  AND is_system = TRUE;

DO $verify$
DECLARE
  section_count integer;
BEGIN
  SELECT (length(system_prompt) - length(replace(system_prompt, 'its browser, and sign in once', '')))
         / length('its browser, and sign in once')
    INTO section_count
  FROM internal_agents
  WHERE system_role = 'caio' AND is_system = TRUE;
  IF section_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 465: expected exactly one team sign-in instruction, found %', section_count;
  END IF;
END
$verify$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
