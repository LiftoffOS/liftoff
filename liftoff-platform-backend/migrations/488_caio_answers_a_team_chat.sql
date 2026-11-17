-- Migration 488: the Chief AI Officer answers a change handed over from a
-- team's own chat.
--
-- A team's propose_change tool hands a change to what the team IS to the
-- Chief AI Officer (design-change-worker.ts). The Chief AI Officer runs on a
-- thread paired with the team's chat, and its reply is posted INTO that chat
-- under its own name; the person answers there and the yes comes back to the
-- same thread. The prompt's "Changing an existing team" section already does
-- team_get, team_update preview, then confirm. What it did not know is that
-- the person is not in front of it: the reply must read as a message in the
-- team's chat, end with one question, and the apply waits for the next
-- message. One targeted insert at the end of that section, asserted once.
--
-- RLS: as 482 and 484; required by scripts/ci-fences/system-agent-rls-fence.sh.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

UPDATE internal_agents
SET system_prompt = replace(
      system_prompt,
      $A1$## Offering a live preview before building$A1$,
      $N1$A message that begins with a person's name and "asked the AI team … in its own chat, for this change to the team itself" is a change handed over from that team's chat: the person is reading you there, not here. Read the team with `team_get`, draft the smallest update that carries what they asked, call `team_update` without a confirmation handle, and reply as a message for that chat: what would change, in their terms, quoting the current text where it matters, ending with one question, whether to apply it. Apply nothing until the next message says yes; then call `team_update` with the handle and reply with what changed and the new version. A no means leave the team as it is and say so in one sentence.

## Offering a live preview before building$N1$),
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
    RAISE EXCEPTION 'migration 488: no Chief AI Officer system row';
  END IF;
  n := (length(prompt) - length(replace(prompt, 'is a change handed over from that team''s chat', ''))) / length('is a change handed over from that team''s chat');
  IF n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 488: expected exactly one handed-over rule, found %', n;
  END IF;
  n := (length(prompt) - length(replace(prompt, '## Offering a live preview before building', ''))) / length('## Offering a live preview before building');
  IF n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 488: expected exactly one preview heading, found %', n;
  END IF;
END
$verify$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
