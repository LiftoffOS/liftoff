-- Migration 430: the Chief AI Officer learns to change an existing team.
--
-- Its charter has always said it "designs, creates and changes AI teams", and
-- until now the prompt only knew how to create: a request to move a team's
-- schedule had no sanctioned move, so the model either pointed at the
-- settings page or improvised. The mechanism shipped ahead of this migration,
-- in order: workforce-service's team__get_config and team__propose_update
-- tools, backed by platform-backend's _svc config read and prose-only PATCH,
-- which lands the edit through the same update-then-redistill path the
-- settings page uses. This migration only teaches the prompt the sequence and
-- its two hard rules: schedules are words inside the prose, never cron
-- expressions, and nothing is called until the user has confirmed the exact
-- before-and-after in the conversation.
--
-- Same mechanics as 384/385/386/428: targeted replace() against an exact
-- anchor, verified to have landed exactly once, inside the NO FORCE / FORCE
-- fence scripts/ci-fences/system-agent-rls-fence.sh requires.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

UPDATE internal_agents
SET system_prompt = replace(
      system_prompt,
      $ANCHOR$## Communication style$ANCHOR$,
      $NEW$## Changing an existing team
When the user asks to change a team that already exists, including its schedule, work from its real configuration, never from memory:

1. Find the team with `org__get_existing_structure`, then read its full configuration with `team__get_config`.
2. Draft the smallest prose edit that carries the change, and show the user the exact before and after, quoting the current text. A schedule is expressed in words inside the prose, such as "Runs every Tuesday at 9am"; never write a cron expression.
3. Only after the user confirms, call `team__propose_update` with the full replacement text for the field you edited, carrying everything they did not ask to change verbatim from `team__get_config`.
4. Then tell the user the rebuild takes a few minutes and the updated team appears on the Teams page.

Do not use `workforce_plan__draft` to change an existing team; plans create new teams.

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
  SELECT (length(system_prompt) - length(replace(system_prompt, '## Changing an existing team', '')))
         / length('## Changing an existing team')
    INTO section_count
  FROM internal_agents
  WHERE system_role = 'caio' AND is_system = TRUE;

  IF section_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 430: expected exactly one "Changing an existing team" section, found %', section_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM internal_agents
    WHERE system_role = 'caio'
      AND is_system = TRUE
      AND system_prompt LIKE '%`team__get_config`%'
      AND system_prompt LIKE '%`team__propose_update`%'
      AND system_prompt LIKE '%never write a cron expression%'
      -- The section it was inserted above survived.
      AND system_prompt LIKE '%## Communication style%'
  ) THEN
    RAISE EXCEPTION 'migration 430: CAIO system_prompt was not updated as expected';
  END IF;
END
$verify$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
