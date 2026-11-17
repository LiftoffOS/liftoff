-- Migration 482: the Chief AI Officer's approval ends the way the builder ends.
--
-- The build wizard, the template gallery and the Switch wizard all finish on
-- one choice, Launch Now or Maybe Later, and raise the payment gate when
-- Launch Now cannot be honoured. The CAIO's flow ended differently: every AI
-- team it provisioned was a draft, the person was sent to the Teams page to
-- press Start, and nothing said whether the workspace could even run one. A
-- person who did everything from Slack or Teams had to leave for the app.
--
-- Now the CAIO reads `team_start_readiness` (a workspace action: the execution
-- guard's own answer, the active count, the connections still missing) before
-- it asks, states what is true, asks the builder's question alongside the
-- approval, and passes the answer to `workforce_plan__approve` as `launch`.
-- workforce-service starts each finished AI team as the approver when they
-- chose to launch, and the completion notice says which started and which
-- could not, in the workspace's own words.
--
-- Four targeted replace() calls against the exact passages the prompt carries
-- today (194 seeded them; 337, 359, 386 and 468 last edited them). A wholesale
-- rewrite would revert every earlier targeted fix it did not restate.
-- replace() on a missing anchor is a silent no-op, so each new text is
-- asserted to land exactly once and each anchor to be gone.
--
-- RLS: internal_agents is FORCE row-level-security and the system row carries
-- tenant_id IS NULL, so no tenant-scoped policy reaches it. Migrations run as
-- liftoff_app, which owns the table; dropping FORCE for the length of this
-- transaction is the owner's equivalent of the admin pool's BYPASSRLS, and
-- ALTER TABLE holds ACCESS EXCLUSIVE until COMMIT. Required by
-- scripts/ci-fences/system-agent-rls-fence.sh.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

UPDATE internal_agents
SET system_prompt = replace(replace(replace(replace(
      system_prompt,
      $A1$Present a clear summary and ask the user if they want to proceed (keep it simple and direct, e.g. "Want me to go ahead and set this up?"). Once the user confirms (e.g. "yes", "go ahead", "looks good"), call `workforce_plan__commit` if you have not already, then `workforce_plan__approve`. Neither takes arguments.$A1$,
      $N1$Before you ask, read `team_start_readiness` with the connector types the plan's AI teams need, so you know whether this workspace can run AI teams right now (canRun, and when not, the workspace's own reason), how many AI teams are already active, and which connections are still missing. Present a clear summary that states what is true, then ask two things in one message: whether to go ahead, and whether to launch the AI teams as soon as they are ready or leave them as drafts. That is the same choice the Teams page's builder ends on (Launch Now or Maybe Later), so offer it in those terms. When the workspace cannot run AI teams, say so in the workspace's own words, say they will be built as drafts that can start once that is resolved, and do not offer to launch. When a connection is missing, say which one and that the AI team needing it will stay a draft until it is connected. Once the user confirms (e.g. "yes", "go ahead", "looks good"), call `workforce_plan__commit` if you have not already, then `workforce_plan__approve` with `launch: true` when they chose to launch, or `launch: false` when they chose drafts or the workspace cannot run AI teams. `workforce_plan__commit` takes no arguments.$N1$),
      $A2$The HRBP Agent then creates each AI team in draft status in the background; they will appear on the Teams page for the user to review and start.$A2$,
      $N2$The HRBP Agent then creates each AI team in the background. When the person chose to launch, each AI team is started for them the moment it is ready, under their name, and the notice posted here when the build finishes says which started and which could not, with the workspace's own reason; otherwise they appear on the Teams page in draft status for the user to review and start.$N2$),
      $A3$Never say "activate" or "launch": neither word appears anywhere in the product.$A3$,
      $N3$Never say "activate". Say "launch" only for the choice made at approval, which mirrors the builder's Launch Now; "start" is the word for the Teams page action.$N3$),
      $A4$Tell the user something like *"Your AI team is being set up and will appear on the Teams page shortly."*$A4$,
      $N4$Tell the user something like *"Your AI team is being set up. I will tell you here when it is ready and whether it started."*$N4$),
    updated_at = NOW()
WHERE system_role = 'caio'
  AND is_system = TRUE;

DO $verify$
DECLARE
  prompt text;
  n integer;
  needle text;
  needles text[] := ARRAY[
    'Before you ask, read `team_start_readiness`',
    'each AI team is started for them the moment it is ready',
    'Say "launch" only for the choice made at approval',
    'I will tell you here when it is ready and whether it started.'
  ];
  anchors text[] := ARRAY[
    'Neither takes arguments.',
    'creates each AI team in draft status in the background',
    'neither word appears anywhere in the product',
    'will appear on the Teams page shortly.'
  ];
BEGIN
  SELECT system_prompt INTO prompt FROM internal_agents WHERE system_role = 'caio' AND is_system = TRUE;
  IF prompt IS NULL THEN
    RAISE EXCEPTION 'migration 482: no Chief AI Officer system row';
  END IF;
  FOREACH needle IN ARRAY needles LOOP
    n := (length(prompt) - length(replace(prompt, needle, ''))) / length(needle);
    IF n IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'migration 482: expected exactly one occurrence of "%", found %', needle, n;
    END IF;
  END LOOP;
  FOREACH needle IN ARRAY anchors LOOP
    IF position(needle IN prompt) > 0 THEN
      RAISE EXCEPTION 'migration 482: the replaced passage "%" is still present', needle;
    END IF;
  END LOOP;
END
$verify$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
