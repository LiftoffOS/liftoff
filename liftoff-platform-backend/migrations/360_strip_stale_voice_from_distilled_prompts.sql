-- Migration 360: remove the inline voice rules from distilled prompts.
--
-- Migration 359 and the change to IC_AGENT_PREAMBLE move the voice rules out of
-- generated text and into the runtime policy layer (packages/shared-types/src/
-- agent-voice.ts, injected by the Tenant Runtime into both the interactive and the
-- autonomous prompt). Prompts distilled before that still carry a copy inline.
--
-- While the two texts agree this is only wasted tokens. It stops being harmless the
-- first time the canonical block is reworded, because then a stored prompt states the
-- previous rule beside the new one and nothing says which wins. So it goes now, while
-- the two still agree and the removal cannot change behaviour.
--
-- SCOPE. A non-system `internal_agents` row may carry:
--     the current preamble  ("Writing quality: sound like a sharp colleague")
--     an older revision     ("Writing quality: avoid AI filler phrases",
--                            introduced in b849953b, ends "many experts believe".)
--     no voice text at all
-- Matching only the current wording would leave every older-revision row untouched
-- while reporting success. Both revisions share the
-- "Writing quality:" anchor and both end at a paragraph break, so the strip is bounded
-- by that break rather than by either revision's closing sentence: it removes any
-- revision, including one nobody has catalogued.
--
-- Checked against both revisions' texts: the strip removes the paragraph
-- and leaves the persona, the two-mode description and the untrusted-data line intact.
--
-- Tenant rows only. The system agents' prompts are managed by their own migrations
-- (359 for the Chief AI Officer), and the HRBP never speaks to a user.
--
-- No redistill is needed. A redistill regenerates the whole persona and skill set to
-- delete one paragraph, which changes far more than it fixes.
--
-- RLS: internal_agents is FORCE row-level-security (migration 287) and migrations run
-- as liftoff_app, which has no BYPASSRLS. The tenant policy evaluates
-- current_setting('app.current_tenant_id') with no missing_ok, so with no GUC set this
-- raises 42704 and aborts, and with one set it would reach a single tenant. Dropping
-- FORCE for the length of this transaction is the owner's equivalent of the admin
-- pool's BYPASSRLS; ALTER TABLE holds ACCESS EXCLUSIVE until COMMIT, so no other
-- session ever observes the table unforced. This writes TENANT rows, so it is outside
-- the system-agent fence, but it needs the same escape for the same reason.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

DO $strip$
DECLARE
  stripped  integer;
  residual  integer;
BEGIN
  UPDATE internal_agents
  SET system_prompt = regexp_replace(
        system_prompt,
        -- From the anchor to the end of that paragraph. `.` matches newline in
        -- Postgres by default, so the non-greedy match runs to the first blank
        -- line; the lookahead keeps the blank line itself, and `$` handles the
        -- case where the paragraph is the last thing in the prompt.
        'Writing quality:.*?(?=\n\n|$)',
        '',
        -- Global. A prompt that was redistilled while the preamble was changing can
        -- carry two of these paragraphs, and without this only the first would go,
        -- leaving exactly the contradiction the migration exists to prevent. The
        -- residual assertion below would catch it; stripping both is better than
        -- failing the deploy over it.
        'g'
      ),
      updated_at = NOW()
  WHERE coalesce(is_system, false) = false
    AND system_prompt LIKE '%Writing quality:%';

  GET DIAGNOSTICS stripped = ROW_COUNT;

  SELECT count(*) INTO residual
  FROM internal_agents
  WHERE coalesce(is_system, false) = false
    AND system_prompt LIKE '%Writing quality:%';

  RAISE NOTICE 'migration 360: stripped inline voice rules from % distilled prompt(s)', stripped;

  -- The point of the migration is that no tenant prompt keeps its own copy. If one
  -- does, the anchor matched but the paragraph bound did not, which means a shape
  -- nobody has seen. Fail loudly rather than half-finish and report success: this is
  -- the exact failure mode the first draft of this migration had.
  IF residual > 0 THEN
    RAISE EXCEPTION 'migration 360: % prompt(s) still carry inline voice rules after the strip; extend the pattern', residual;
  END IF;
END
$strip$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
