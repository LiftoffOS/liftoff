-- Migration 471: the Chief AI Officer scores a company's marketing current
-- state before proposing a marketing team.
--
-- Discovery for a marketing outcome has had no shape of its own. Asked for
-- "help with marketing", the CAIO interviews the person from the generic
-- Discovery bullet and proposes whichever members the conversation happened
-- to reach, so two companies with opposite gaps (a strong voice nobody hears,
-- and traffic that never converts) get the same first members. The seventeen
-- areas below are the current-state lens that decides which gap is widest,
-- and the five shapes that recur are what map a scored table onto the members
-- to propose first. Scoring is done from what the CAIO can already read (the
-- website through its web tools, the connected systems through the connector
-- tools, whatever the person shares), so the interview shrinks to what the
-- scoring could not read, which is the same discipline the deliverable-first
-- flows (428/430/432) apply.
--
-- Two rules in the section have reasons that are not visible from here:
--   - "take those scores as given": a person who already ran a scored
--     assessment must not watch the CAIO redo it; the prior scores are the
--     ground truth for the areas they cover and only an area with current
--     evidence that it moved is re-scored.
--   - "a judgement score carries its one-line reason": four areas are read
--     from data when the systems are connected and four from visible
--     artifacts; the rest are interpretive, and an interpretive score with no
--     reason cannot be pushed back on.
--
-- Targeted replace() against an exact anchor, the 384/385/386/428/432/439/469
-- pattern: a wholesale rewrite reverts every prior targeted fix it does not
-- re-state. The new section is inserted immediately above "## Communication
-- style", which after 469 places it directly after "## Workspace
-- administration" (and after "## The browser and the web", 439, which the
-- verify block still orders against); 462 to 466 and 468 edit sentences
-- elsewhere in the prompt and leave that anchor untouched. replace() on a
-- missing anchor is a silent no-op, so the DO block asserts the section
-- landed exactly once.
--
-- Numbered 471 rather than 464: this migration was written against a main
-- whose last CAIO migration was 463, and 464 to 470 landed before it merged.
-- A migration is never renumbered once applied anywhere; this one has been
-- applied nowhere.
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
      $NEW$## Marketing intake
When the outcome the person wants is marketing (a department that maps to marketing, or an outcome about acquisition, activation, retention, referral or revenue), Discovery has a fixed shape: score the company's marketing current state before proposing any AI team, so the first members you propose close the widest gap rather than the most familiar one.

Score seventeen areas 0 to 5 each from what you can read (the website through your web tools, the connected systems through the connector tools, anything the person shares): positioning; customer research; homepage; sales and product pages; conversion pages; competitor comparison; resources and content; onboarding; email lifecycle; sales material; messaging; pricing; conversion optimisation; launches; paid; SEO; internationalisation. Sales material does not apply to a pure consumer business; say so rather than scoring it. Four areas are read from data when the systems are connected (SEO, paid, email lifecycle, onboarding), four from visible artifacts (pricing, conversion optimisation, conversion pages, sales material), and the rest are judgement; a judgement score carries its one-line reason so the person can push back on it.

Mark the result "scored from materials" and name what you read. When the person already has a scored assessment, take those scores as given, note their date, and re-score only an area where you have current evidence that it moved. Never redo work that exists.

Read the shape, not the total. Five shapes recur, and each says where the first members go:
- strong positioning, research and messaging with weak SEO, paid and launches: distribution has not caught up; propose acquisition members first.
- strong SEO, content and paid with weak homepage, onboarding, conversion pages and pricing: traffic arrives and does not convert; propose activation and revenue members first.
- strong onboarding, homepage and pricing with weak email lifecycle and conversion optimisation: people sign up and leave; propose retention members first.
- strong positioning and research and little else: pre-marketing; the first quarter is foundations, and the first members are advisory before any are operational.
- strong paid, sales material and pricing with weak SEO, content and referral: performance marketing carries the business; propose the compounding channels before paid scales further.

Present the scores as a short table with the shape in two to four sentences beneath it, then propose the members. Keep the interview to what the scoring could not read.

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
  SELECT (length(system_prompt) - length(replace(system_prompt, '## Marketing intake', '')))
         / length('## Marketing intake')
    INTO section_count
  FROM internal_agents
  WHERE system_role = 'caio' AND is_system = TRUE;

  IF section_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 471: expected exactly one "Marketing intake" section, found %', section_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM internal_agents
    WHERE system_role = 'caio'
      AND is_system = TRUE
      AND system_prompt LIKE '%Read the shape, not the total.%'
      -- The section the insert anchored on survived, in its place after the
      -- new one.
      AND position('## Marketing intake' in system_prompt) < position('## Communication style' in system_prompt)
      AND position('## The browser and the web' in system_prompt) < position('## Marketing intake' in system_prompt)
      AND position('## Workspace administration' in system_prompt) < position('## Marketing intake' in system_prompt)
  ) THEN
    RAISE EXCEPTION 'migration 471: CAIO system_prompt was not updated as expected';
  END IF;
END
$verify$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
