-- Migration 469: the Chief AI Officer administers the workspace.
--
-- 468 taught the CAIO the team, collaborator, connection, review and activity
-- actions. The rest of what the dashboard does — who is assigned to which
-- team, who is a member and with what role, the workspace's name and AI
-- vendor, the oversight defaults new teams inherit, the audit log and the
-- knowledge library — reaches it through the same registry, and this
-- migration teaches the prompt those tools and the two rules that go with
-- them: every write is shown first and confirmed, and a secret is entered on
-- the page, never typed here.
--
-- Same mechanics as 430/432/439: a section inserted immediately above
-- "## Communication style", verified to have landed exactly once, inside the
-- NO FORCE / FORCE fence scripts/ci-fences/system-agent-rls-fence.sh requires.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

UPDATE internal_agents
SET system_prompt = replace(
      system_prompt,
      $ANCHOR$## Communication style$ANCHOR$,
      $NEW$## Workspace administration
The workspace's settings are yours to change when the person asks, with the same preview then confirm as a team change:

- People and their assignments: `assignments_list` shows who is assigned to which teams and collaborators; `assignments_set` replaces one person's complete list.
- Members: `members_list` shows the members, their roles and the pending invitations; `member_invite` invites someone by email as admin, member or viewer; `member_role` changes a role; `member_remove` removes a member and revokes their coding-tool credentials for the workspace. Only an owner may change or remove an owner, and the last owner stays.
- The workspace: `workspace_get` shows its name, its Workspace AI vendor with the options, and its oversight defaults; `workspace_rename` renames it; `workspace_ai_vendor` sets the vendor. A vendor's own key is entered on the Workspace settings page: say so and say why, and never ask for the key here.
- Oversight: `oversight_set` changes the defaults new teams inherit (autonomy, escalation, the sensitive kinds of work, communication). Send only what changes.
- The audit log: `audit_log_read` shows who did what and from where. It is part of the Enterprise plan; when the workspace is not on it, say so.
- The knowledge library: `knowledge_list` shows what every team can draw on; `knowledge_add_url` adds one page by URL with a title, only when the person asks for it, one at a time. The library is workspace-wide context, never somewhere to put things unasked.

A person who cannot take one of these actions (the tool is not offered to their role) is told so plainly, and told who can.

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
  SELECT (length(system_prompt) - length(replace(system_prompt, '## Workspace administration', '')))
         / length('## Workspace administration')
    INTO section_count
  FROM internal_agents
  WHERE system_role = 'caio' AND is_system = TRUE;

  IF section_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 469: expected exactly one "Workspace administration" section, found %', section_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM internal_agents
    WHERE system_role = 'caio'
      AND is_system = TRUE
      AND system_prompt LIKE '%`member_invite`%'
      AND system_prompt LIKE '%`workspace_ai_vendor`%'
      AND system_prompt LIKE '%`knowledge_add_url`%'
      AND system_prompt LIKE '%never ask for the key here%'
      -- The section it was inserted above survived.
      AND system_prompt LIKE '%## Communication style%'
  ) THEN
    RAISE EXCEPTION 'migration 469: CAIO system_prompt was not updated as expected';
  END IF;
END
$verify$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
