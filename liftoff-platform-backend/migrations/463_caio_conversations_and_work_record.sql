-- Migration 463: the conversation tools are the workspace's, and the trail comes as a work record.
--
-- 462 taught the Chief AI Officer to read the trail of what it did before
-- drafting, through two tools it named as the person's OWN conversations. That
-- was a narrower rule than the product's: team-plan threads are shared in the
-- workspace — any member may open any thread, several people take part in
-- one, links are shared — so a colleague who joined a thread, or an admin, was
-- told the conversation did not exist. Workforce-service now scopes the tools
-- the way the product does (read what the person could open; list what their
-- history page lists) under the names `conversations__list` and
-- `conversation__read`, and the read returns a WORK RECORD: the trail rendered
-- as an ordered list of steps, so the workflows section is carried over rather
-- than re-derived from raw tool JSON.
--
-- PROMPT COPY FLAGGED FOR OPERATOR REVIEW before this migration ships.
--
-- Same mechanics as 462: targeted replace() against the exact instruction 462
-- inserted, verified to have landed exactly once, inside the NO FORCE / FORCE
-- fence scripts/ci-fences/system-agent-rls-fence.sh requires.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

UPDATE internal_agents
SET system_prompt = replace(
      system_prompt,
      $ANCHOR$1. Read the work before drafting. Call `own_conversation__read` with no id for this conversation; it returns what was said and, for each of your turns, the trail of what you did — the sites you opened, the capabilities you ran with their arguments, and what came back. Your own memory of the conversation is the prose; the trail is the record. When the person refers to work from another time ("the other day", "our last chat", "the lead list"), call `own_conversations__list`, pick the conversation they mean by its title and date, and read that one by id. Ask which one only when two could be it.
2. Draft from the trail, not from a summary of it. Every site, capability and argument that produced the result belongs in the workflows section in the order it happened; carry the person's wording, the exact URLs, and the corrections they made verbatim. Do not call `source_conversation__read` for work done with you -- it reads only a paired Liftoff conversation.$ANCHOR$,
      $NEW$1. Read the work before drafting. Call `conversation__read` with no id for this conversation; it returns what was said, for each of your turns the trail of what you did — the sites you opened, the capabilities you ran with their arguments, and what came back — and a work record: that trail as a numbered list of steps. Your own memory of the conversation is the prose; the record is what happened. When the person refers to work from another time ("the other day", "our last chat", "the lead list"), call `conversations__list`, pick the conversation they mean by its title and date, and read that one by id. It lists what their history page shows them, including conversations colleagues started that they can open. Ask which one only when two could be it.
2. Carry the work record into the workflows section as it is, in its order, and add around it only what the record cannot say: the person's wording, the exact URLs, and the corrections they made, verbatim. Do not re-derive the steps from the raw trail when the record already lists them. Do not call `source_conversation__read` for work done with you -- it reads only a paired Liftoff conversation.$NEW$
    ),
    updated_at = NOW()
WHERE system_role = 'caio'
  AND is_system = TRUE;

DO $verify$
DECLARE
  section_count integer;
BEGIN
  SELECT (length(system_prompt) - length(replace(system_prompt, 'Carry the work record into the workflows section', '')))
         / length('Carry the work record into the workflows section')
    INTO section_count
  FROM internal_agents
  WHERE system_role = 'caio' AND is_system = TRUE;
  IF section_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 463: expected exactly one "Carry the work record" instruction, found %', section_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM internal_agents
    WHERE system_role = 'caio'
      AND is_system = TRUE
      AND system_prompt LIKE '%`conversation__read`%'
      AND system_prompt LIKE '%`conversations__list`%'
      AND system_prompt NOT LIKE '%`own_conversation__read`%'
      AND system_prompt NOT LIKE '%`own_conversations__list`%'
      AND system_prompt LIKE '%## Building from work already done%'
  ) THEN
    RAISE EXCEPTION 'migration 463: CAIO system_prompt was not updated as expected';
  END IF;
END
$verify$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
