-- Migration 515: a sign-in the trail already shows is reused, not asked about.
--
-- Rule 5 of "Building from work already done" asked the sign-in question for
-- every sign-in in the trail: whether the AI team should have its own sign-in
-- for that site or stop and hand that step to the person each time. Two
-- things the trail can now show make that question wrong to ask. A sign-in
-- the person did in this AI team's own pane persists in the AI team's browser
-- profile, which a run-owned session opens with, so the AI team is already
-- signed in when its run reaches the site. And a sign-in the browser did
-- itself, from a login saved in the workspace's 1Password vault, happens again
-- on every browser wherever the runtime moves the page, with no model and no
-- person in the loop. In both, the workflow's sign-in step is to continue as
-- signed in, check that the site is signed in when the run reaches it, and,
-- when it is not, stop and ask through the run's own question path rather
-- than guess. The question remains for a sign-in done in an assistant's pane
-- (whose profile is not the AI team's) and for a site the trail never shows
-- signed in.
--
-- One sentence replaced, on an anchor that occurs exactly once as migrations
-- 1 to 514 leave the prompt (509 rewrote it to say "AI team"). The sentence
-- that follows the question, what to write and what to tell the person when
-- they choose the AI team's own sign-in, stays as it is. The DO block raises
-- unless the new text appears exactly once and the anchor is gone.
--
-- RLS: as 482, 484, 488, 500, 501, 509 and 512; required by
-- scripts/ci-fences/system-agent-rls-fence.sh.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

UPDATE internal_agents
SET system_prompt = replace(
      system_prompt,
      $Ho$For a sign-in, ask whether the AI team should have its own sign-in for that site or stop and hand that step to the person each time.$Ho$,
      $Hn$For a sign-in: when the trail shows the sign-in was done in this AI team's own pane, or shows the browser signing in from a saved login, the workflow reuses that: its sign-in step is to continue with the AI team's browser profile or the saved login, check that the site is signed in when the run reaches it, and, when it is not, stop and ask for the sign-in through the run's own question path rather than guess; say that in the preview and ask nothing else about it. Ask the sign-in question, whether the AI team should have its own sign-in for that site or stop and hand that step to the person each time, only for a sign-in done in an assistant's pane or on a site the trail never shows signed in.$Hn$
    ),
    updated_at = NOW()
WHERE system_role = 'caio'
  AND is_system = TRUE;

DO $verify$
DECLARE
  prompt text;
  n integer;
BEGIN
  SELECT system_prompt INTO prompt FROM internal_agents WHERE system_role = 'caio' AND is_system = TRUE;
  IF prompt IS NULL THEN
    RAISE EXCEPTION 'migration 515: no Chief AI Officer system row';
  END IF;
  n := (length(prompt) - length(replace(prompt, 'For a sign-in, ask whether the AI team should have its own sign-in for that site or stop and hand that step to the person each time.', ''))) / length('For a sign-in, ask whether the AI team should have its own sign-in for that site or stop and hand that step to the person each time.');
  IF n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'migration 515: expected the sign-in question sentence to be replaced, found % still present', n;
  END IF;
  n := (length(prompt) - length(replace(prompt, 'For a sign-in: when the trail shows the sign-in was done in this AI team''s own pane, or shows the browser signing in from a saved login, the workflow reuses that:', ''))) / length('For a sign-in: when the trail shows the sign-in was done in this AI team''s own pane, or shows the browser signing in from a saved login, the workflow reuses that:');
  IF n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 515: expected exactly one of the reuse sentence, found %', n;
  END IF;
  n := (length(prompt) - length(replace(prompt, 'only for a sign-in done in an assistant''s pane or on a site the trail never shows signed in.', ''))) / length('only for a sign-in done in an assistant''s pane or on a site the trail never shows signed in.');
  IF n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 515: expected exactly one of the narrowed question sentence, found %', n;
  END IF;
  -- The sentence after the question is untouched: what to write and what to
  -- tell the person when they choose the AI team's own sign-in.
  n := (length(prompt) - length(replace(prompt, 'When they choose the AI team''s own sign-in, write the step into the workflows section as the AI team doing it', ''))) / length('When they choose the AI team''s own sign-in, write the step into the workflows section as the AI team doing it');
  IF n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 515: expected exactly one of the own-sign-in sentence, found %', n;
  END IF;
END
$verify$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
