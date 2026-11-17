-- Migration 497: the Chief AI Officer recognises a hand-over by the brief's
-- opening, now that the brief is for it alone.
--
-- 488 and 496 keyed the hand-over rule on what the person's message looked
-- like: a team's hand-over "begins with a person's name and 'asked the AI team
-- …'", a colleague's "opens with 'Liftoff shared background from the
-- conversation so far'". Both shapes have changed. The brief a colleague
-- writes is no longer persisted or shown; it is put in front of the person's
-- message for the model only, and it opens by saying so:
--
--   Background from <colleague>, which brought you into this conversation. It
--   is not shown to the person: do not repeat it, or any identifier in it, to
--   them. Answer the message that follows it.
--
-- A team's hand-over travels the same way now (the team is the colleague), so
-- every hand-over the Chief AI Officer receives opens with "Background from".
-- One targeted rewrite of the sentence 496 produced, asserted once before and
-- once after. The rule itself, preview then apply on yes, is untouched.
--
-- RLS: as 482, 484, 488 and 496; required by scripts/ci-fences/system-agent-rls-fence.sh.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

DO $before$
DECLARE
  prompt text;
  n integer;
BEGIN
  SELECT system_prompt INTO prompt FROM internal_agents WHERE system_role = 'caio' AND is_system = TRUE;
  IF prompt IS NULL THEN
    RAISE EXCEPTION 'migration 497: no Chief AI Officer system row';
  END IF;
  n := (length(prompt) - length(replace(prompt, 'A message that begins with a person''s name and "asked the AI team', ''))) / length('A message that begins with a person''s name and "asked the AI team');
  IF n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 497: expected exactly one hand-over sentence to rewrite, found %', n;
  END IF;
  n := (length(prompt) - length(replace(prompt, 'shared background from the conversation so far', ''))) / length('shared background from the conversation so far');
  IF n IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'migration 497: expected the two openings 496 wrote, found %', n;
  END IF;
END
$before$;

UPDATE internal_agents
SET system_prompt = replace(
      system_prompt,
      $A1$A message that begins with a person's name and "asked the AI team … in its own chat, for this change to the team itself" is a change handed over from that team's chat, and a message that opens with "Liftoff shared background from the conversation so far" or "Insights Manager shared background from the conversation so far" and asks for a change to an existing team is a change handed over from that colleague's chat: in both, the person is reading you there, not here.$A1$,
      $N1$A message that opens with "Background from" names the colleague that brought you in and says the person does not see that paragraph; never repeat it, or an identifier from it, to them. When it goes on to say a person "asked the AI team … in its own chat, for this change to the team itself", it is a change handed over from that team's chat; when the colleague is Liftoff or the Insights Manager and the message asks for a change to an existing team, it is a change handed over from that colleague's chat: in both, the person is reading you there, not here.$N1$),
    updated_at = NOW()
WHERE system_role = 'caio'
  AND is_system = TRUE;

DO $verify$
DECLARE
  prompt text;
  n integer;
BEGIN
  SELECT system_prompt INTO prompt FROM internal_agents WHERE system_role = 'caio' AND is_system = TRUE;
  n := (length(prompt) - length(replace(prompt, 'A message that opens with "Background from"', ''))) / length('A message that opens with "Background from"');
  IF n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 497: expected exactly one hand-over sentence, found %', n;
  END IF;
  n := (length(prompt) - length(replace(prompt, 'shared background from the conversation so far', ''))) / length('shared background from the conversation so far');
  IF n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'migration 497: expected the old openings gone, found %', n;
  END IF;
  n := (length(prompt) - length(replace(prompt, 'is a change handed over from that team''s chat', ''))) / length('is a change handed over from that team''s chat');
  IF n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 497: expected the team hand-over rule to survive once, found %', n;
  END IF;
END
$verify$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
