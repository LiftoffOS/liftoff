-- Migration 462: the Chief AI Officer drafts from what it DID, here and in earlier chats.
--
-- The way a standing team comes to exist is a person working with the CAIO
-- over one or more conversations — it browses, reads what is there, runs
-- capabilities, acts on the data — and then asking for that work to be
-- automated. The prompt already said the work may have happened "right here"
-- and to draft from this conversation, but the CAIO could draw only on the
-- prose in its context: what it did — the sites, the arguments, the
-- capabilities, the outcomes — was not kept, and an earlier conversation was
-- out of reach entirely.
--
-- Workforce-service now keeps the trail of each turn's tool calls (its
-- migration 025) and gives the CAIO `own_conversations__list` and
-- `own_conversation__read`. This migration replaces the "right here"
-- paragraph with the instruction to draft from the trail, and to find and
-- read the earlier conversation the person points at.
--
-- PROMPT COPY FLAGGED FOR OPERATOR REVIEW before this migration ships.
--
-- Same mechanics as 384/385/386/428/430/432: targeted replace() against an
-- exact anchor, verified to have landed exactly once, inside the NO FORCE /
-- FORCE fence scripts/ci-fences/system-agent-rls-fence.sh requires.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

UPDATE internal_agents
SET system_prompt = replace(
      system_prompt,
      $ANCHOR$The work may also have happened right here, in this conversation with you: the person worked through the task using your browser and web tools, saw the result, and now wants it to keep happening. In that case do not call `source_conversation__read` -- it reads only a paired Liftoff conversation, and there is nothing behind this one. The source is the conversation you are already in. Draft from it the same way: carry the person's wording, the exact URLs, and the corrections verbatim, ask only the delta questions, and treat what the browser did here as material for the workflows section.$ANCHOR$,
      $NEW$The work may also have happened with you — in this conversation, or in an earlier one with this person. When they ask to automate it, turn it into a team, or make it keep happening:

1. Read the work before drafting. Call `own_conversation__read` with no id for this conversation; it returns what was said and, for each of your turns, the trail of what you did — the sites you opened, the capabilities you ran with their arguments, and what came back. Your own memory of the conversation is the prose; the trail is the record. When the person refers to work from another time ("the other day", "our last chat", "the lead list"), call `own_conversations__list`, pick the conversation they mean by its title and date, and read that one by id. Ask which one only when two could be it.
2. Draft from the trail, not from a summary of it. Every site, capability and argument that produced the result belongs in the workflows section in the order it happened; carry the person's wording, the exact URLs, and the corrections they made verbatim. Do not call `source_conversation__read` for work done with you -- it reads only a paired Liftoff conversation.
3. Ask only the delta questions: how often, where the result goes, and what should differ from the one-off run. Do not re-interview the person about work they watched you do.
4. Describe browser steps by their URLs, identity names and actions, never by a browser product name, and a capability by what it does, never by the vendor behind it.$NEW$
    ),
    updated_at = NOW()
WHERE system_role = 'caio'
  AND is_system = TRUE;

-- Verified while FORCE is still off. replace() on a missing anchor is a
-- silent no-op that still reports one row updated, so the inserted text is
-- asserted present exactly once and the anchor asserted gone.
DO $verify$
DECLARE
  section_count integer;
BEGIN
  SELECT (length(system_prompt) - length(replace(system_prompt, '1. Read the work before drafting.', '')))
         / length('1. Read the work before drafting.')
    INTO section_count
  FROM internal_agents
  WHERE system_role = 'caio' AND is_system = TRUE;
  IF section_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 462: expected exactly one "Read the work before drafting" instruction, found %', section_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM internal_agents
    WHERE system_role = 'caio'
      AND is_system = TRUE
      AND system_prompt LIKE '%`own_conversation__read`%'
      AND system_prompt LIKE '%`own_conversations__list`%'
      AND system_prompt NOT LIKE '%there is nothing behind this one%'
      -- The section it sits in survived.
      AND system_prompt LIKE '%## Building from work already done%'
      AND system_prompt LIKE '%## Changing an existing team%'
  ) THEN
    RAISE EXCEPTION 'migration 462: CAIO system_prompt was not updated as expected';
  END IF;
END
$verify$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
