-- Migration 432: the Chief AI Officer learns to offer a live preview.
--
-- The deliverable-first loop has run in one direction since 426/428: a person
-- does the work with Liftoff, Liftoff delegates here, and the absorb entry
-- mode reads the source conversation instead of re-interviewing. A person who
-- arrives HERE cold had no path to that loop: the interview was the only
-- opening move even when one demonstrated result would answer more of it than
-- questions can. The mechanism shipped ahead of this migration:
-- workforce-service's preview_with_liftoff tool, backed by platform-backend's
-- /api/internal/preview route, which creates a Liftoff conversation
-- seeded with the task and PAIRED to this thread, so the existing
-- source_conversation__read return trip absorbs whatever happens there. This
-- migration only teaches the prompt when to offer it and the two hard rules:
-- at most one preview conversation per thread, and a preview is offered,
-- never required.
--
-- PROMPT COPY FLAGGED FOR OPERATOR REVIEW before this migration ships.
--
-- Same mechanics as 384/385/386/428/430: targeted replace() against an exact
-- anchor, verified to have landed exactly once, inside the NO FORCE / FORCE
-- fence scripts/ci-fences/system-agent-rls-fence.sh requires.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

UPDATE internal_agents
SET system_prompt = replace(
      system_prompt,
      $ANCHOR$## Communication style$ANCHOR$,
      $NEW$## Offering a live preview before building
When the person is unsure what they want built, or when seeing one real result would answer more of the interview than questions can, offer to demonstrate the deliverable first:

1. Agree the task with the person in plain words.
2. Call `preview_with_liftoff` with that task and the name this surface shows for you. It creates a Liftoff conversation, opened with your note, where the person can do the work once with Liftoff.
3. Tell the person to continue in that Liftoff conversation and to return here when the result looks right. Do not draft a plan for that work while the preview is in progress.
4. When they return, call `source_conversation__read` FIRST and draft from what actually happened there, exactly as you would for any conversation whose work already happened.

Call `preview_with_liftoff` at most once per conversation and reuse the conversation it created; a second call would split the work in two. A preview is offered, never required: when the person already knows what they want built, build it.

## Communication style$NEW$
    ),
    updated_at = NOW()
WHERE system_role = 'caio'
  AND is_system = TRUE;

-- Verified while FORCE is still off. replace() on a missing anchor is a
-- silent no-op that still reports one row updated, so the inserted section is
-- asserted present exactly once (which also catches double application).
DO $verify$
DECLARE
  section_count integer;
BEGIN
  SELECT (length(system_prompt) - length(replace(system_prompt, '## Offering a live preview before building', '')))
         / length('## Offering a live preview before building')
    INTO section_count
  FROM internal_agents
  WHERE system_role = 'caio' AND is_system = TRUE;

  IF section_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 432: expected exactly one "Offering a live preview" section, found %', section_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM internal_agents
    WHERE system_role = 'caio'
      AND is_system = TRUE
      AND system_prompt LIKE '%`preview_with_liftoff`%'
      AND system_prompt LIKE '%A preview is offered, never required%'
      -- The section it was inserted above survived.
      AND system_prompt LIKE '%## Communication style%'
  ) THEN
    RAISE EXCEPTION 'migration 432: CAIO system_prompt was not updated as expected';
  END IF;
END
$verify$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
