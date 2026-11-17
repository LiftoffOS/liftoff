-- Migration 496: the Chief AI Officer answers a change handed over from a
-- colleague's chat, whoever the colleague is.
--
-- 488 taught the Chief AI Officer the shape of a change handed over from a
-- team's own chat: preview the update as a message for that chat, end with
-- one question, apply on the next yes. The Insights Manager and Liftoff can
-- now hand a turn to the Chief AI Officer the same way (agent-chat/
-- handover.ts): the person is reading the reply on the Insights or Liftoff
-- page, the Chief AI Officer's own thread is paired with that conversation,
-- and the next "yes" arrives as another hand-over into the same thread. The
-- rule is the same; only the way the hand-over announces itself differs. A
-- team's hand-over is a message in the person's name; a colleague's carries
-- the forwarded-context note in front of the person's own words, whose
-- first line names the colleague (liftoff/forwarded-context.ts).
--
-- One targeted rewrite of 488's opening sentence, asserted once before and
-- once after. The rest of the paragraph, which is the rule itself, is
-- untouched.
--
-- RLS: as 482, 484 and 488; required by scripts/ci-fences/system-agent-rls-fence.sh.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

DO $before$
DECLARE
  prompt text;
  n integer;
BEGIN
  SELECT system_prompt INTO prompt FROM internal_agents WHERE system_role = 'caio' AND is_system = TRUE;
  IF prompt IS NULL THEN
    RAISE EXCEPTION 'migration 496: no Chief AI Officer system row';
  END IF;
  n := (length(prompt) - length(replace(prompt, 'is a change handed over from that team''s chat: the person is reading you there, not here.', ''))) / length('is a change handed over from that team''s chat: the person is reading you there, not here.');
  IF n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 496: expected exactly one handed-over rule to rewrite, found %', n;
  END IF;
END
$before$;

UPDATE internal_agents
SET system_prompt = replace(
      system_prompt,
      $A1$is a change handed over from that team's chat: the person is reading you there, not here.$A1$,
      $N1$is a change handed over from that team's chat, and a message that opens with "Liftoff shared background from the conversation so far" or "Insights Manager shared background from the conversation so far" and asks for a change to an existing team is a change handed over from that colleague's chat: in both, the person is reading you there, not here.$N1$),
    updated_at = NOW()
WHERE system_role = 'caio'
  AND is_system = TRUE;

DO $verify$
DECLARE
  prompt text;
  n integer;
BEGIN
  SELECT system_prompt INTO prompt FROM internal_agents WHERE system_role = 'caio' AND is_system = TRUE;
  n := (length(prompt) - length(replace(prompt, 'is a change handed over from that colleague''s chat', ''))) / length('is a change handed over from that colleague''s chat');
  IF n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 496: expected exactly one colleague hand-over rule, found %', n;
  END IF;
  n := (length(prompt) - length(replace(prompt, 'is a change handed over from that team''s chat', ''))) / length('is a change handed over from that team''s chat');
  IF n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 496: expected the team hand-over rule to survive once, found %', n;
  END IF;
END
$verify$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
