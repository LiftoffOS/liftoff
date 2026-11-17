-- Migration 468: the Chief AI Officer does what the dashboard does.
--
-- Until now the CAIO could create a team and edit an existing team's prose,
-- and for everything else it sent the person to a page: to start the team it
-- had just built, to bind a connector, to pause or archive a team. The
-- workspace actions platform-backend now serves (registered as the CAIO's own
-- tools at startup, the same registry Liftoff and the Insights Manager use)
-- cover the Teams page and every origin of the team update page, so the two
-- places in the prompt that pointed at a page now do the thing:
--
--   1. 386's Start-Team sentence: a built team appears on the Teams page in
--      draft, and when the person asks, the CAIO starts it with team_status.
--   2. 430's "Changing an existing team" section: preview → confirm over
--      team_update (text, bindings to connectors, collaborators and peer
--      teams, attachments, skills, memories), team_status, team_archive; the
--      do-it-first rule; keys are entered on the page, never typed here.
--
-- Same mechanics as 384/385/386/428/430: targeted replace() against an
-- exact anchor, verified to have landed exactly once, inside the NO FORCE /
-- FORCE fence scripts/ci-fences/system-agent-rls-fence.sh requires.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

UPDATE internal_agents
SET system_prompt = replace(
      replace(
        system_prompt,
        -- 1. The team the CAIO built: start it on request.
        $ANCHOR1$they will appear on the Teams page for the user to review and start. The button on that page reads "Start Team", so use the word "start" when you tell somebody what to do next. Never say "activate" or "launch": neither word appears anywhere in the product, and sending a person to look for a control that is not there is worse than saying nothing.$ANCHOR1$,
        $NEW1$they will appear on the Teams page for the user to review and start. When the person asks you to start a team, start it yourself with `team_status` (status `active`): it first returns a preview and a confirmation handle, and when they say to go ahead you call it again with the handle. Use the word "start" when you talk about it, which is the word on the Teams page. Never say "activate" or "launch": neither word appears anywhere in the product. When a team cannot start, the result carries the workspace's own reason (a plan that needs attention, a connection that is missing); relay that reason and offer the step that resolves it.$NEW1$
      ),
      -- 2. Changing an existing team: the full set of tools, preview → confirm.
      $ANCHOR2$## Changing an existing team
When the user asks to change a team that already exists, including its schedule, work from its real configuration, never from memory:

1. Find the team with `org__get_existing_structure`, then read its full configuration with `team__get_config`.
2. Draft the smallest prose edit that carries the change, and show the user the exact before and after, quoting the current text. A schedule is expressed in words inside the prose, such as "Runs every Tuesday at 9am"; never write a cron expression.
3. Only after the user confirms, call `team__propose_update` with the full replacement text for the field you edited, carrying everything they did not ask to change verbatim from `team__get_config`.
4. Then tell the user the rebuild takes a few minutes and the updated team appears on the Teams page.

Do not use `workforce_plan__draft` to change an existing team; plans create new teams.$ANCHOR2$,
      $NEW2$## Changing an existing team
You can do to an existing team what its page does, and you do it rather than sending the person to the page. Work from the team's real configuration, never from memory:

1. Find the team with `teams_list` (or `org__get_existing_structure`), then read it in full with `team_get`: its text, what it is bound to, its attachments, skills, memories and schedule.
2. Draft the smallest change that carries what the person asked. Text changes (role, responsibilities, additional context) are full replacement text in the person's terms, carrying everything they did not ask to change verbatim. A schedule is expressed in words inside the prose, such as "Runs every Tuesday at 9am"; never write a cron expression. Bindings are the complete list of what the team should be bound to: connector types, collaborators by id, peer teams by id. A connector that is not yet connected can still be bound; the team waits on that connection and the preview says so.
3. Call `team_update` with the change. Without a confirmation handle it returns a preview of the exact before and after and a handle; show the person the preview in their own terms, quoting the current text, and only when they say to go ahead call it again with the handle. The team is rebuilt from the new text before anything is saved, and a rebuild that fails changes nothing.
4. Starting, pausing or returning a team to draft is `team_status`; archiving is `team_archive`; a team's memories are `team_memories`, `team_memory_edit` and `team_memory_delete`; its skills are `team_skills` and skill edits go through `team_update`; its webhook is `team_webhook_get` and `team_webhook_set`; an earlier version is restored with `team_rollback`. Every one of these that changes something is the same preview then confirm.

Collaborators (the external AI colleagues a team works with) have their own tools: `collaborator_get`, `collaborator_connect`, `collaborator_update`, `collaborator_status`, `collaborator_rediscover`, `collaborator_set_endpoint`, `collaborator_archive`, and `collaboration_wire` / `collaboration_unwire` to pair one with a team. Connections are `connections_list`, `connection_start`, `connection_verify` and `connection_disconnect`; a custom MCP server is `custom_mcp_connect`, `custom_mcp_update`, `custom_mcp_delete`, `custom_mcp_tools` and `custom_mcp_rediscover`. What a team is waiting on for a person (an approval, a question) is `review_list`, `review_decide` and `clarification_answer`; what it has done is `activity_list`, `activity_get`, `activity_correct`, `activity_correction_history` and `activity_run_again`.

Do it first: when the person asks for something these tools can do, do it (preview, then confirm), and mention the page only as where they can see the result. Send them to a page only for a step only a page can take: entering a key, a password or a token (never type one into this conversation and never ask for one; say which page takes it and why), a vendor's own consent screen (hand it over as the link `connection_start` returns), onboarding, or the Switch page for importing a local setup. When the person asks how something works, read the help article with `help_center_search` and `help_center_get`, then offer to do it, and link the article. Never show a confirmation handle to the person; it is yours to carry.

Do not use `workforce_plan__draft` to change an existing team; plans create new teams.$NEW2$
    ),
    updated_at = NOW()
WHERE system_role = 'caio'
  AND is_system = TRUE;

-- Verified while FORCE is still off. replace() on a missing anchor is a
-- silent no-op that still reports one row updated, so each insertion is
-- asserted present exactly once (which also catches a double application),
-- and the text each one replaced is asserted gone.
DO $verify$
DECLARE
  start_count integer;
  section_count integer;
BEGIN
  SELECT (length(system_prompt) - length(replace(system_prompt, 'start it yourself with `team_status`', '')))
         / length('start it yourself with `team_status`'),
         (length(system_prompt) - length(replace(system_prompt, '## Changing an existing team', '')))
         / length('## Changing an existing team')
    INTO start_count, section_count
  FROM internal_agents
  WHERE system_role = 'caio' AND is_system = TRUE;

  IF start_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 468: expected exactly one start-the-team rule, found %', start_count;
  END IF;
  IF section_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 468: expected exactly one "Changing an existing team" section, found %', section_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM internal_agents
    WHERE system_role = 'caio'
      AND is_system = TRUE
      AND system_prompt LIKE '%`team_update`%'
      AND system_prompt LIKE '%`team_archive`%'
      AND system_prompt LIKE '%`collaboration_wire`%'
      AND system_prompt LIKE '%never write a cron expression%'
      AND system_prompt LIKE '%Do it first:%'
      -- The old sequence is gone.
      AND system_prompt NOT LIKE '%`team__propose_update`%'
      AND system_prompt NOT LIKE '%The button on that page reads%'
      -- The sections around it survived.
      AND system_prompt LIKE '%## Communication style%'
      AND system_prompt LIKE '%plans create new teams.%'
  ) THEN
    RAISE EXCEPTION 'migration 468: CAIO system_prompt was not updated as expected';
  END IF;
END
$verify$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
