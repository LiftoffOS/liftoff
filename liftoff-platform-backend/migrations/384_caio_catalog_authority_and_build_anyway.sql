-- Migration 384: the Chief AI Officer stops denying connectors it cannot see,
-- and stops ruling on what Liftoff should integrate.
--
-- Asked for an automation someone had read about, the CAIO could answer:
--
--   "We do not have a webclaw connector, and it is not the kind of thing we
--    would wire up as a dedicated connector even if it existed (it is a
--    single-purpose scraping endpoint from someone else's blog post, not a
--    general integration). I would not go chase that URL down."
--
-- Both halves were wrong, and they were wrong for different reasons.
--
-- The FACT can be wrong when connectors__list_available answers from an array
-- hardcoded in the tool rather than the real catalog: every connector missing
-- from the array does not exist as far as the CAIO can tell, even one that is
-- connectable and on the Connections page the person is looking at. That is
-- fixed separately, in workforce-service: the tool now reads the live catalog
-- and reports when it could not.
--
-- The prompt still has to change, for two reasons the tool fix does not cover.
--
-- First, the denial was SCRIPTED here. The bullet being replaced below handed
-- the model the sentence "We do not have a [X] connector yet" and no instruction
-- to check anything first, so a stale tool answer became a confident product
-- statement. The replacement makes the tool the only authority, and makes an
-- unreadable catalog a reason to say so rather than a reason to deny.
--
-- Second, nothing in this prompt ever told the CAIO that a missing connector is
-- not the end of the conversation. Its three sanctioned alternatives were "a
-- similar supported connector, an external integration via MCP, or a manual
-- workflow", and the prompt contained neither the word "sandbox" nor any mention
-- of the platform research tools, which is exactly the capability that can build
-- what such a person asks for. A CAIO whose solution space is the connector
-- catalog cannot do the job the CAIO exists to do. The new section states the
-- mandate and names what a provisioned team actually gets.
--
-- The capability claims in that section are deliberately narrow and were checked
-- against src/internal-agents/distill-service.ts before being written here:
--   - the five platform research tools (web_research, web_fetch_advanced,
--     web_deep_research, web_people_search, web_finance_search) are available to
--     EVERY agent with no connector and no workspace, and return sourced results
--   - a sandbox with code execution exists for a team the distiller gives
--     `capabilityNeeds.workspace: true`, which it sets when the work needs one,
--     so it is stated as conditional
--   - custom MCP servers are a real, separate path (custom_mcp_server)
-- Overstating any of these would recreate the defect this migration is fixing,
-- one step further down.
--
-- Targeted replace(), not a wholesale rewrite. 359 replaced the prompt outright
-- and had to fold 336 and 337 back in by hand or silently revert them; three
-- replaces against exact anchors cannot revert anything they do not name. The
-- risk of replace() is the opposite one, a no-op that reports success, and the
-- verification block below is what closes it: it asserts the new text landed AND
-- that the replaced text is gone.
--
-- RLS: internal_agents is FORCE row-level-security and system agents carry
-- tenant_id IS NULL, so no tenant-scoped policy reaches this row. Migrations run
-- as liftoff_app, which owns the table, so dropping FORCE for the length of this
-- transaction is the owner's equivalent of the admin pool's BYPASSRLS. ALTER
-- TABLE holds ACCESS EXCLUSIVE until COMMIT, so no other session observes the
-- table unforced. Required by scripts/ci-fences/system-agent-rls-fence.sh.
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
          -- 1. The catalog, not the model's memory, decides what exists.
          $OLD1$- Always call `connectors__list_available` early to know which integrations are supported and which are connected.$OLD1$,
          $NEW1$- Call `connectors__list_available` early, and treat its answer as the ONLY authority on what Liftoff supports. It returns the live catalog, which holds well over a hundred connectors and gains more most weeks. You do not know that catalog from memory, so never answer a "do you support X" question from memory.$NEW1$
        ),
        -- 2. The scripted denial, replaced by three rules that make a denial the
        --    last branch rather than the first.
        $OLD2$- If the user asks for an app that is not in our supported connector catalog, be transparent: "We do not have a [X] connector yet." Then suggest alternatives: a similar supported connector, an external integration via MCP, or a manual workflow. Save the request to memory for product signal.$OLD2$,
        $NEW2$- Before saying we lack an app, look for it in the tool's answer, including under a different brand name. If the tool reports that the catalog could not be read, then you do not know: say you could not check which integrations are available and offer to look again. Absence from a list you were told is incomplete is not evidence of anything.
- When the catalog does list an app the person named and it is simply not connected, say that and point at the fix: "We support [X]. Connect it on the Connections page and [AI team name] can use it." Never describe a supported connector as one we do not have.
- When the catalog genuinely does not list it, say "We do not have a [X] connector yet", save the request to memory for product signal, and then keep going and design the team around what does exist. Do not speculate about whether we would ever add it, do not rank the request, and do not comment on the app, its vendor, or where the person came across it. What Liftoff integrates is not yours to rule on.$NEW2$
      ),
      -- 3. The mandate, inserted immediately above the connector rules so it is
      --    read before them.
      $ANCHOR$## Connector guidance$ANCHOR$,
      $NEW3$## Designing around what exists
Someone describing an automation they want has described your job. A missing connector changes how an AI team does the work. It does not decide whether you design one. Work out what the outcome needs, build the closest thing that reaches it with what is available today, and say plainly which part is covered and which part is not.

An AI team is not limited to its connectors. Every team you can provision also has:
- Platform research tools, available to every team with no connector and no setup. They read live public web pages and search the web, and they return sourced results with citations. Any "read this site, research this topic, find these people, check that pricing page" responsibility is these tools.
- A private sandbox with code execution, given to a team whose work needs one. It covers calling a programmatic HTTP API, transforming data, and producing a file.
- A custom MCP server, for a specific product the person holds an API key for that no connector covers.

So a named product having no connector is rarely the end of the answer. Say what the team will do.

Do not editorialise about a request. Whether an idea is worth building, whether some tool is a real product, and whether the person's source is any good are not your calls to make. Design the team, or say precisely what stops you.

## Connector guidance$NEW3$
    ),
    updated_at = NOW()
WHERE system_role = 'caio'
  AND is_system = TRUE;

-- Verified while FORCE is still off, so the check reads the row it just wrote.
--
-- replace() on a string that does not match is a silent no-op that leaves the
-- UPDATE reporting a row count of 1, so "it ran" proves nothing. Each half is
-- asserted: the new text is present, and the text it replaced is gone. The
-- single-occurrence check on the new section catches a double application.
DO $verify$
DECLARE
  section_count integer;
BEGIN
  SELECT (length(system_prompt) - length(replace(system_prompt, '## Designing around what exists', '')))
         / length('## Designing around what exists')
    INTO section_count
  FROM internal_agents
  WHERE system_role = 'caio' AND is_system = TRUE;

  IF section_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 384: expected exactly one "Designing around what exists" section, found %', section_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM internal_agents
    WHERE system_role = 'caio'
      AND is_system = TRUE
      -- The mandate and the capabilities it rests on.
      AND system_prompt LIKE '%Platform research tools, available to every team%'
      AND system_prompt LIKE '%private sandbox with code execution%'
      AND system_prompt LIKE '%Do not editorialise about a request%'
      -- The catalog is the authority.
      AND system_prompt LIKE '%treat its answer as the ONLY authority%'
      AND system_prompt LIKE '%What Liftoff integrates is not yours to rule on%'
      AND system_prompt LIKE '%Never describe a supported connector as one we do not have%'
      -- The two replaced strings are gone.
      AND system_prompt NOT LIKE '%early to know which integrations are supported and which are connected%'
      AND system_prompt NOT LIKE '%Then suggest alternatives: a similar supported connector%'
      -- The section it was inserted above survived.
      AND system_prompt LIKE '%## Connector guidance%'
  ) THEN
    RAISE EXCEPTION 'migration 384: CAIO system_prompt was not updated as expected';
  END IF;
END
$verify$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
