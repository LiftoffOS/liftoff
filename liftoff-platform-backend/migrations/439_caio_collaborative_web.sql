-- Migration 439: the Chief AI Officer works with the web instead of
-- declining it.
--
-- Asked "What do you see on espn.com?", the CAIO opened the page in the pane
-- and then refused to describe it: "my role is helping you design and
-- provision AI teams, not act as a general browsing assistant". Nothing
-- enforces that refusal — it is emergent from the prompt. Every CAIO turn
-- carries the provider-executed web tools (workforce-service passes
-- WEB_SERVER_TOOLS precisely so the CAIO can read a page it is asked about),
-- and `run_browser_task` can read any page the pane can reach. But the only
-- web language in the prompt was the Research bullet, which authorises web
-- use solely "to inform your recommendations" — a model reads that as the
-- whole grant, and the browser tool results ("the person can see it")
-- complete the picture of an assistant that opens pages for others and never
-- reads one itself.
--
-- That rigidity now works against the product: the deliverable-first flows
-- (426/428/430/432) all assume a CAIO willing to do the work at hand with the
-- person before formalising it into a team. Three targeted edits:
--
--   1. The Research bullet stops reading as an exclusive grant: web tools
--      also serve direct questions from the person.
--   2. A new section teaches the mechanics the model cannot infer: the pane
--      shows pages to the PERSON, reading is a separate act it can and
--      should perform, and a page question is part of the job. `web_fetch`
--      is named with a fallback because it is genuinely conditional: the
--      Vertex platform serves Claude without it (anthropic-shared.ts drops
--      it there), while `run_browser_task` exists on every turn.
--   3. "Building from work already done" learns the second source: the work
--      may have happened right here, in the CAIO's own conversation, in
--      which case `source_conversation__read` has nothing behind it and the
--      draft comes from the conversation itself.
--
-- Targeted replace() against exact anchors, the 384/385/386/428/432 pattern:
-- a wholesale rewrite reverts every prior targeted fix it does not re-state.
-- replace() on a missing anchor is a silent no-op, so the DO block asserts
-- each new text landed exactly once.
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
      replace(
        replace(
          system_prompt,
          -- 1. The Research bullet names both uses of the web tools, so the
          --    "to inform your recommendations" clause stops reading as the
          --    only authorised one.
          $OLD1$4. **Research**: You have access to web search. Use it when you need current information about industries, tools, regulations, or market trends to inform your recommendations. Do NOT use it for internal company data -- use the org and connector tools for that.$OLD1$,
          $NEW1$4. **Research**: You have web search and web page reading. Use them when you need current information about industries, tools, regulations, or market trends, and just as much when the person asks about a page or a site directly. Do NOT use them for internal company data -- use the org and connector tools for that.$NEW1$
        ),
        -- 2. The mechanics of the pane versus reading, inserted immediately
        --    above the communication rules like 428's and 432's sections.
        $ANCHOR$## Communication style$ANCHOR$,
        $NEW2$## The browser and the web
You can work with the web together with the person, and a question about what is on a page is part of the job, not outside it.

- When the person asks what is on a page or what you can see on a site, read the page and describe it. Use `web_fetch` when it is available to you; when it is not, or when reaching the content takes interaction, hand the reading to `run_browser_task` and report what it found.
- `navigate_browser_session` shows the person a page in the panel beside this conversation. It does not show the page to you. Opening a page for them and reading it yourself are two different acts, and a question like "what do you see" usually calls for both.
- Never decline to look at or describe a page on the grounds that browsing is not your role. If your tools can answer it, answer it. Working through a page together is often the start of the real work: what you read and did on the web is exactly the material "Building from work already done" turns into an AI team, so help first and let the team conversation follow from the result.

## Communication style$NEW2$
      ),
      -- 3. The second source of already-done work: this very conversation.
      --    Appended to the absorb section by anchoring on the section that
      --    follows it (inserted by 430).
      $ANCHOR2$## Changing an existing team$ANCHOR2$,
      $NEW3$The work may also have happened right here, in this conversation with you: the person worked through the task using your browser and web tools, saw the result, and now wants it to keep happening. In that case do not call `source_conversation__read` -- it reads only a paired Liftoff conversation, and there is nothing behind this one. The source is the conversation you are already in. Draft from it the same way: carry the person's wording, the exact URLs, and the corrections verbatim, ask only the delta questions, and treat what the browser did here as material for the workflows section.

## Changing an existing team$NEW3$
    ),
    updated_at = NOW()
WHERE system_role = 'caio'
  AND is_system = TRUE;

-- Verified while FORCE is still off, so the check reads the row it just
-- wrote. replace() on a missing anchor is a silent no-op that still reports
-- one row updated, so each insertion is asserted present exactly once (which
-- also catches a double application).
DO $verify$
DECLARE
  section_count integer;
  research_count integer;
  self_source_count integer;
BEGIN
  SELECT (length(system_prompt) - length(replace(system_prompt, '## The browser and the web', '')))
         / length('## The browser and the web'),
         (length(system_prompt) - length(replace(system_prompt, 'You have web search and web page reading', '')))
         / length('You have web search and web page reading'),
         (length(system_prompt) - length(replace(system_prompt, 'The work may also have happened right here', '')))
         / length('The work may also have happened right here')
    INTO section_count, research_count, self_source_count
  FROM internal_agents
  WHERE system_role = 'caio' AND is_system = TRUE;

  IF section_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 439: expected exactly one "The browser and the web" section, found %', section_count;
  END IF;

  IF research_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 439: expected exactly one rewritten Research bullet, found %', research_count;
  END IF;

  IF self_source_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 439: expected exactly one self-source paragraph, found %', self_source_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM internal_agents
    WHERE system_role = 'caio'
      AND is_system = TRUE
      AND system_prompt LIKE '%Never decline to look at or describe a page%'
      AND system_prompt NOT LIKE '%You have access to web search%'
      -- The sections the inserts anchored on survived.
      AND system_prompt LIKE '%## Communication style%'
      AND system_prompt LIKE '%## Changing an existing team%'
  ) THEN
    RAISE EXCEPTION 'migration 439: CAIO system_prompt was not updated as expected';
  END IF;
END
$verify$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
