-- Migration 472: a marketing plan the Chief AI Officer drafts names the
-- company's funding stage and ties every move to the stage that can pay for
-- it.
--
-- A marketing plan written as if budget were unconstrained is a wish list:
-- it recommends paid acquisition to a bootstrapped company and a brand
-- campaign to one that just closed its seed round. The prompt has had no
-- notion of stage, so a plan's honesty about what is executable today
-- depended on the conversation happening to raise it. The five stages below
-- and what each unlocks give the CAIO one vocabulary for that, and the
-- application rules keep a move above the current stage IN the plan, labelled
-- with the stage that unlocks it, rather than dropped or pretended
-- affordable. The same gate applies to the members it proposes: an executing
-- paid-media member is a move the stage with a paid budget pays for; an
-- advisory one is available at any stage.
--
-- No amounts appear in the section on purpose. The stage names are stable;
-- any budget figure attached to them is a benchmark that would be read as a
-- fact about this company, which is the failure the intake section (471)
-- exists to avoid.
--
-- Targeted replace() against an exact anchor, the 384/385/386/428/432/439/469/471
-- pattern. The new section is inserted immediately above "## Communication
-- style", which after 471 places it directly after "## Marketing intake".
-- replace() on a missing anchor is a silent no-op, so the DO block asserts
-- the section landed exactly once.
--
-- RLS: internal_agents is FORCE row-level-security and system agents carry
-- tenant_id IS NULL, so no tenant-scoped policy reaches this row. Migrations
-- run as liftoff_app, which owns the table, so dropping FORCE for the length
-- of this transaction is the owner's equivalent of the admin pool's BYPASSRLS.
-- ALTER TABLE holds ACCESS EXCLUSIVE until COMMIT, so no other session
-- observes the table unforced. Required by
-- scripts/ci-fences/system-agent-rls-fence.sh.
--
-- Does not touch the AGENT_VOICE_BLOCK section, so
-- scripts/__tests__/caio-prompt-voice-sync.test.ts stays pointed at 359.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

UPDATE internal_agents
SET system_prompt = replace(
      system_prompt,
      $ANCHOR$## Communication style$ANCHOR$,
      $NEW$## Funding stage and what it unlocks
A marketing plan written as if budget were unconstrained is a wish list. Every marketing plan you draft names the company's funding stage and ties each move to the stage that can pay for it, so what is executable today and what the next round buys are both explicit. Ask the stage once when it is not already in the workspace context; never infer it from the size of the company.

Five stages, and what each unlocks:
- bootstrapped or pre-seed: no paid acquisition; organic only (search, content, founder-led social, community, events); founder-led press; the AI teams do the operational lift with no marketing hire.
- seed closed: a paid-acquisition test budget and the first dedicated marketing hire; the funding announcement is the first press push; the first launch.
- seed deployed: paid scales on the channels the test proved; a second marketing hire; lifecycle and content run as programmes.
- series A: paid across every proven channel; brand campaigns become possible; performance, content and design leads; international consideration; attribution worth building.
- series B and later: brand at category scale; a full marketing organisation; agencies and sponsorships.

Apply it this way:
- State the current stage in the plan's current-state section.
- A move the current stage cannot pay for stays in the plan, labelled with the stage that unlocks it and held until then. Never drop it, and never present it as affordable now.
- The twelve-month outlook names the stage active in each quarter, and a stage change is a moment to re-plan.
- When the person asks for a move above their stage, name the stage it needs and the timing; do not refuse it. When they underestimate what a move needs, say what it needs. When they are funded beyond their stage, recommend the work the funnel state calls for and say the rest is better spent on compounding channels than on scaling paid.
- The members you propose follow the same gate: an executing paid-media member belongs to the stage with a paid budget; an advisory one is available at any stage.

## Communication style$NEW$
    ),
    updated_at = NOW()
WHERE system_role = 'caio'
  AND is_system = TRUE;

-- Verified while FORCE is still off, so the check reads the row it just
-- wrote. replace() on a missing anchor is a silent no-op that still reports
-- one row updated, so the insertion is asserted present exactly once (which
-- also catches a double application).
DO $verify$
DECLARE
  section_count integer;
BEGIN
  SELECT (length(system_prompt) - length(replace(system_prompt, '## Funding stage and what it unlocks', '')))
         / length('## Funding stage and what it unlocks')
    INTO section_count
  FROM internal_agents
  WHERE system_role = 'caio' AND is_system = TRUE;

  IF section_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 472: expected exactly one "Funding stage and what it unlocks" section, found %', section_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM internal_agents
    WHERE system_role = 'caio'
      AND is_system = TRUE
      AND system_prompt LIKE '%Five stages, and what each unlocks:%'
      -- Ordered after the intake section (471) and before the anchor it was
      -- inserted above.
      AND position('## Marketing intake' in system_prompt) < position('## Funding stage and what it unlocks' in system_prompt)
      AND position('## Funding stage and what it unlocks' in system_prompt) < position('## Communication style' in system_prompt)
  ) THEN
    RAISE EXCEPTION 'migration 472: CAIO system_prompt was not updated as expected';
  END IF;
END
$verify$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
