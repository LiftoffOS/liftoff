-- Migration 386: the Chief AI Officer names the button the person will click.
--
-- The CAIO tells people a new AI team is waiting "for the user to review and
-- activate". The button on the Teams page says **Start Team**. It has never said
-- Activate: the only "Activate Team" string in the frontend is in a Storybook
-- file (RecentItemCard.stories.tsx), and the live label comes from
-- internalAgents.ts / externalAgents.ts / AgentChatPage.tsx, all of which return
-- "Start Team".
--
-- So the last thing the CAIO says about a team it just built names a control
-- that does not exist. Somebody who reads it goes looking for Activate, and the
-- page offers Start. That is a small defect with an outsized cost, because it
-- lands at the exact moment the person is being asked to do something.
--
-- The replacement does not just swap the verb. It names the button, because a
-- prompt that says "start" without saying why will drift back to a synonym the
-- next time the model writes the sentence in its own words: "launch" and
-- "activate" are both natural English for this, and neither is on the screen.
-- Pinning the rule to the label is what makes it hold.
--
-- Scope: this is the CAIO's PROMISE, made when the plan is approved. The
-- matching CONFIRMATION, posted by workforce-service when provisioning actually
-- finishes, is composed in code and carried the same wrong verb; it changes in
-- that repo alongside this. Fixing one and not the other would leave the promise
-- and the confirmation disagreeing about what the person is meant to click.
--
-- The same sentence exists in migrations 194 and 327, both applied and both
-- superseded by 359's wholesale rewrite, so 359's copy is the live one and the
-- only one this needs to reach. Applied migrations are never edited.
--
-- Composes with 385, which is also a targeted replace() against this prompt but
-- against the last bullet of "## Connector guidance". The two anchors do not
-- overlap.
--
-- RLS: internal_agents is FORCE row-level-security and system agents carry
-- tenant_id IS NULL, so no tenant-scoped policy reaches this row. Migrations run
-- as liftoff_app, which owns the table, so dropping FORCE for the length of this
-- transaction is the owner's equivalent of the admin pool's BYPASSRLS. ALTER
-- TABLE holds ACCESS EXCLUSIVE until COMMIT, so no other session observes the
-- table unforced. Required by scripts/ci-fences/system-agent-rls-fence.sh.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

UPDATE internal_agents
SET system_prompt = replace(
      system_prompt,
      $ANCHOR$they will appear on the Teams page for the user to review and activate.$ANCHOR$,
      $NEW$they will appear on the Teams page for the user to review and start. The button on that page reads "Start Team", so use the word "start" when you tell somebody what to do next. Never say "activate" or "launch": neither word appears anywhere in the product, and sending a person to look for a control that is not there is worse than saying nothing.$NEW$
    ),
    updated_at = NOW()
WHERE system_role = 'caio'
  AND is_system = TRUE;

-- Verified while FORCE is still off, so the check reads the row it just wrote.
--
-- replace() on a string that does not match is a silent no-op that still reports
-- one row updated, so "it ran" proves nothing. Both halves are asserted: the new
-- rule is present exactly once, and the sentence it replaced is gone.
DO $verify$
DECLARE
  rule_count integer;
BEGIN
  SELECT (length(system_prompt) - length(replace(system_prompt, 'The button on that page reads', '')))
         / length('The button on that page reads')
    INTO rule_count
  FROM internal_agents
  WHERE system_role = 'caio' AND is_system = TRUE;

  IF rule_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 386: expected exactly one Start Team rule, found %', rule_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM internal_agents
    WHERE system_role = 'caio'
      AND is_system = TRUE
      AND system_prompt LIKE '%for the user to review and start.%'
      AND system_prompt NOT LIKE '%for the user to review and activate.%'
  ) THEN
    RAISE EXCEPTION 'migration 386: CAIO system_prompt still names a button that does not exist';
  END IF;
END
$verify$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
