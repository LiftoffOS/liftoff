-- Migration 428: the Chief AI Officer learns to build from work already done.
--
-- Some conversations reach the CAIO after the work has already happened once:
-- the person worked through the task with Liftoff, saw the result, and asked
-- for it to keep happening. Until now the CAIO's only entry mode was Discovery
-- ("Interview the user... Do not rush"), so it re-interviewed a person who had
-- just finished demonstrating what they want. The demonstration is better
-- source material than the interview: it carries the exact URLs, the field
-- names, the ordering rules, and the corrections the person made along the
-- way, which is precisely the detail the draft tool's prose slots ask to be
-- carried verbatim.
--
-- The mechanism this rides shipped ahead of it: workforce-service's
-- source_conversation__read tool calls platform-backend's
-- /api/internal/source-conversation route, which resolves the
-- delegation pairing and returns the conversation's speech, its rolling
-- summary, and the browser-activity trail (migration 426). This migration only
-- teaches the prompt when and how to use it, plus one pointer at the end of
-- the Discovery line so the two entry modes name each other.
--
-- Two rules in the new section have reasons that are not visible from here:
--   - "never by a browser product name": the runtime's web-tool router picks
--     the browser vendor at call time (a tenant's own connector over the
--     platform default), so prose that names a vendor pins work that would
--     otherwise survive a vendor swap unchanged.
--   - "a step taken over by the user is a step you did not see": takeover
--     segments are deliberately unrecorded (they skew toward sign-ins), so the
--     trail marks only their boundaries. The honest move is one targeted
--     question, and the two offered answers map one-to-one onto config the
--     distiller can produce (a web identity, or a stop-and-hand-over step).
--
-- Targeted replace() against exact anchors, the 384/385/386 pattern: a
-- wholesale rewrite reverts every prior targeted fix it does not re-state.
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
        system_prompt,
        -- 1. Discovery names its exception, so the interview is never applied
        --    to a conversation that already contains the answers.
        $OLD1$1. **Discovery**: Interview the user to understand their business context, existing team structure, key challenges, and goals. Ask clarifying questions before drafting. Do not rush.$OLD1$,
        $NEW1$1. **Discovery**: Interview the user to understand their business context, existing team structure, key challenges, and goals. Ask clarifying questions before drafting. Do not rush. The one exception is a conversation whose work already happened: see "Building from work already done".$NEW1$
      ),
      -- 2. The second entry mode, inserted immediately above the communication
      --    rules so it reads as a peer of the responsibilities list.
      $ANCHOR$## Communication style$ANCHOR$,
      $NEW2$## Building from work already done
Some conversations reach you after the work has already happened once. The user worked through the task with Liftoff in the conversation this thread was brought in from, saw the result, and now wants it to keep happening or to become an AI team. The forwarded background will say the work already happened in that conversation. When it does:

1. Call `source_conversation__read` FIRST, before asking the user anything. It returns that conversation's messages, a rolling summary when the thread is long, and a browser activity trail when the browser pane was used. Call it again on a later turn whenever you need to look again.
2. Draft from what actually happened. Carry the user's own wording and operational detail into the spec prose verbatim: exact URLs, field names, ordering rules, and the corrections they made along the way. The deliverable the conversation produced is the exemplar for the outcomes and workflows sections.
3. Ask only delta questions before presenting the draft: how often the work should run, where the result should be delivered, and anything that should differ from the one-off run. Do not re-interview the user about work they just showed you.
4. Browser steps in the trail are material for the workflows section. Describe browser work by its steps, URLs and identity names, never by a browser product name.
5. A trail step marked as taken over by the user is a step you did not see. Never guess what happened in it. Ask one targeted question instead: should the AI team have its own sign-in for that site, or stop and hand that step to the user each time.
6. If the source conversation shows one of the workspace's existing AI teams did the work, check `org__get_existing_structure` and prefer routing the standing work to that team over creating a duplicate.

## Communication style$NEW2$
    ),
    updated_at = NOW()
WHERE system_role = 'caio'
  AND is_system = TRUE;

-- Verified while FORCE is still off, so the check reads the row it just wrote.
-- replace() on a missing anchor is a silent no-op that still reports one row
-- updated, so each insertion is asserted to be present exactly once (which
-- also catches a double application). The Discovery replacement keeps its old
-- text as a prefix, so only the added sentence can be asserted.
DO $verify$
DECLARE
  section_count integer;
  pointer_count integer;
BEGIN
  SELECT (length(system_prompt) - length(replace(system_prompt, '## Building from work already done', '')))
         / length('## Building from work already done'),
         (length(system_prompt) - length(replace(system_prompt, 'see "Building from work already done"', '')))
         / length('see "Building from work already done"')
    INTO section_count, pointer_count
  FROM internal_agents
  WHERE system_role = 'caio' AND is_system = TRUE;

  IF section_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 428: expected exactly one "Building from work already done" section, found %', section_count;
  END IF;

  IF pointer_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 428: expected exactly one Discovery pointer, found %', pointer_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM internal_agents
    WHERE system_role = 'caio'
      AND is_system = TRUE
      AND system_prompt LIKE '%Call `source_conversation__read` FIRST%'
      AND system_prompt LIKE '%never by a browser product name%'
      AND system_prompt LIKE '%Do not re-interview the user%'
      -- The section it was inserted above survived.
      AND system_prompt LIKE '%## Communication style%'
  ) THEN
    RAISE EXCEPTION 'migration 428: CAIO system_prompt was not updated as expected';
  END IF;
END
$verify$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
