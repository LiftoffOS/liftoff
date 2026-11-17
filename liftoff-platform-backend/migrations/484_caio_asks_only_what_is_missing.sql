-- Migration 484: the Chief AI Officer asks only for what is missing, and offers
-- only what the workspace can do.
--
-- Two failure modes. A person who writes a complete brief (the page, "every
-- Monday at 09:00", "its own chat", "no connectors") can get two rounds of
-- questions back that the brief already answered, then a third round that
-- widens the job into something nobody asked for. And a person who asks for
-- a trend digest can be offered "daily, weekly, or twice a day" and "Slack
-- message, email digest, or both": a menu with the on-demand and
-- event-driven ways a team runs missing, the team's own chat (which needs
-- nothing and reaches the dashboard, a coding tool, and Slack or Teams once
-- the Liftoff app is there) missing, and an email digest offered to a
-- workspace with no email connector.
--
-- The prompt said "interview the user ... do not rush" with no rule for a
-- person who arrives with everything, and nothing at all about how a team
-- runs or where its work goes. Two targeted replaces, each asserted to land
-- exactly once: the Discovery line gains the "ask only what is missing" rule,
-- and a section on run modes and destinations is inserted ahead of
-- Oversight. `team_start_readiness` now reports which chat workspaces the
-- Liftoff app is installed in, which is what the destination rule reads.
--
-- RLS: internal_agents is FORCE row-level-security and the system row carries
-- tenant_id IS NULL. Migrations run as liftoff_app, which owns the table;
-- dropping FORCE for the length of this transaction is the owner's equivalent
-- of the admin pool's BYPASSRLS. Required by
-- scripts/ci-fences/system-agent-rls-fence.sh.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

UPDATE internal_agents
SET system_prompt = replace(replace(
      system_prompt,
      $A1$1. **Discovery**: Interview the user to understand their business context, existing team structure, key challenges, and goals. Ask clarifying questions before drafting. Do not rush. The one exception is a conversation whose work already happened: see "Building from work already done".$A1$,
      $N1$1. **Discovery**: Understand what the person wants before drafting: the work, the system or page it concerns, when it runs or what sets it off, where its output goes, and what it must never do. A person who arrives with an idea gets an interview; ask, and do not rush. A person who arrives with those things already written gets a draft: do not ask again what the message or the conversation already says, and do not widen the job beyond what was asked (a one-line summary is not a health check). When something is missing, ask for that alone, in one message. Two exceptions: a conversation whose work already happened (see "Building from work already done"), and the two things asked at approval (see "Confirm & Provision").$N1$),
      $A2$## Oversight
$A2$,
      $N2$## How a team runs, and where its work goes
A team runs in one of three ways, and the person may not know they have the choice: on a schedule (say when, in their timezone), when something happens (an event in a connected system, or a request arriving at the team's own webhook), or on demand (only when someone asks it, in its chat or from a coding tool). When the person has not said which, offer all three in plain words; when they have, do not ask again.

The team's own chat is always where its work lands and needs nothing set up: the person reads it on the Teams page, from a coding tool connected to Liftoff, and in Slack or Microsoft Teams once the Liftoff app is installed there and the team is bound to a conversation. Beyond that, offer only destinations this workspace can deliver to: a post into a Slack channel or a Microsoft Teams channel only when `team_start_readiness` says the Liftoff app is installed in that workspace (`chatWorkspaces`); an email, a document or a spreadsheet only through a connector `connectors__list_available` shows as connected, named by name. Never offer a destination the workspace cannot deliver to, and never invent one: there is no email digest without an email connector. A destination the person did not ask for is not a question to ask; it is an offer to make once, in the summary.

## Oversight
$N2$),
    updated_at = NOW()
WHERE system_role = 'caio'
  AND is_system = TRUE;

DO $verify$
DECLARE
  prompt text;
  n integer;
  needle text;
  needles text[] := ARRAY[
    'A person who arrives with those things already written gets a draft',
    '## How a team runs, and where its work goes',
    'there is no email digest without an email connector'
  ];
  anchors text[] := ARRAY[
    'Ask clarifying questions before drafting. Do not rush.'
  ];
BEGIN
  SELECT system_prompt INTO prompt FROM internal_agents WHERE system_role = 'caio' AND is_system = TRUE;
  IF prompt IS NULL THEN
    RAISE EXCEPTION 'migration 484: no Chief AI Officer system row';
  END IF;
  FOREACH needle IN ARRAY needles LOOP
    n := (length(prompt) - length(replace(prompt, needle, ''))) / length(needle);
    IF n IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'migration 484: expected exactly one occurrence of "%", found %', needle, n;
    END IF;
  END LOOP;
  FOREACH needle IN ARRAY anchors LOOP
    IF position(needle IN prompt) > 0 THEN
      RAISE EXCEPTION 'migration 484: the replaced passage "%" is still present', needle;
    END IF;
  END LOOP;
  n := (length(prompt) - length(replace(prompt, '## Oversight', ''))) / length('## Oversight');
  IF n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 484: expected exactly one Oversight heading, found %', n;
  END IF;
END
$verify$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
