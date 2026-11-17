-- The Chief AI Officer's prompt learns the product's new word.
--
-- WHAT CHANGED AND WHY. The noun the product uses for the software that does the
-- work changes: "AI team" becomes "agent", and "external collaborator" becomes
-- "external agent". "The AI workforce" and "the human workforce" are kept,
-- because they name everyone at once and nothing else says that. The reasoning
-- (invariant INV-PB-016): a coined noun makes the product harder to read for
-- anyone who arrives from an ecosystem where this thing is called an agent, and
-- "agent" is the word they already know.
--
-- WHY THIS IS A MIGRATION AT ALL. Three of the four surfaces that carry the voice
-- rules import AGENT_VOICE_BLOCK, so a reworded rule reaches them the moment the
-- module changes. The fourth is this row: a seeded `internal_agents.system_prompt`
-- written by migration 509 and patched since by 512, 515 and 545. It is a string
-- in a .sql file that no compiler, linter or test would otherwise read, and it is
-- the copy that silently goes stale.
--
-- WHY A SUBSTITUTION RATHER THAN A FRESH 30,000-CHARACTER PROMPT. 509 replaced the
-- prompt wholesale because it was rewriting the rules. This is not rewriting
-- anything: it is one vocabulary swap over whatever the row currently holds, which
-- is 509's text with 512's, 515's and 545's replacements already in it. Restating
-- the whole prompt here would mean re-deriving that cumulative text by hand and
-- would silently drop any of it I got wrong. A substitution cannot lose a
-- paragraph it does not mention.
--
-- ORDER MATTERS in the nested replace(). The possessive runs before the singular
-- or "AI team's" becomes "agent" with a stranded "'s"; the plural runs before the
-- singular or "AI teams" becomes "agents" only by accident of the trailing s.
--
-- NOT TOUCHED, deliberately: "Microsoft Teams" (the phrase "AI team" cannot
-- overlap it), "the AI workforce" and "the human workforce" (kept), and bare
-- "team", which still means people and agents together and is governed by its own
-- rule in the voice block rather than by a find and replace.

BEGIN;

-- internal_agents is FORCE RLS and this row is a system agent (tenant_id IS NULL),
-- so the policy would reject the write. Required by
-- scripts/ci-fences/system-agent-rls-fence.sh.
ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

-- THE VOCABULARY RULE ITSELF NEEDS A SEPARATE PASS, AND IT HAS TO RUN LAST.
--
-- The rule does not merely USE the retired noun, it NAMES the forbidden word:
-- the old sentence reads `never "agent"`. A noun swap leaves that clause alone,
-- so the prompt would end up telling the model never to say the one word it is
-- now required to say. That is not a cosmetic miss. It is a prompt that
-- contradicts the rest of itself, which produces confident wrong output rather
-- than an error, and nothing downstream would have reported it.
--
-- Replacing the whole sentence FIRST does not work either, and the reason is
-- worth writing down because it is the kind of ordering bug that looks correct
-- in review: the corrected sentence itself contains `never "AI team"` and
-- `says "AI team"`, so the noun passes that follow would rewrite those right
-- back to "agent" and restore the contradiction.
--
-- So the nouns run innermost and the sentence pass runs outermost, matching the
-- text as the noun passes leave it. Deterministic, and each pass sees exactly
-- one shape of input.
UPDATE internal_agents
SET system_prompt =
      replace(
      replace(
      replace(
      replace(
      replace(
      replace(
      replace(
      replace(
      replace(
        system_prompt,
        $a$AI team's$a$, $b$agent's$b$),
        $a$AI Team's$a$, $b$Agent's$b$),
        $a$AI teams$a$,  $b$agents$b$),
        $a$AI Teams$a$,  $b$Agents$b$),
        $a$AI team$a$,   $b$agent$b$),
        $a$AI Team$a$,   $b$Agent$b$),
        $a$external collaborators$a$, $b$external agents$b$),
        $a$external collaborator$a$,  $b$external agent$b$),
        -- The sentence as the eight passes above leave it, which is not the
        -- sentence any migration ever wrote: it is their output.
        $v$- Say "agent" or "agents", or the agent's own name, never "agent" and never "team" on its own: a team is people and agents together. An AI colleague from outside the workspace is an "external agent". The people are "people", "the person" or "members", never "team members". Only when speaking of everyone at once are the agents and the external agents together "the AI workforce" and the people "the human workforce". This holds even if the person says "agent" or "team" to you.$v$,
        $w$- Say "agent" or "agents", or the agent's own name, never "AI team" and never "team" on its own: a team is people and agents together. An AI colleague from outside the workspace is an "external agent". The people are "people", "the person" or "members", never "team members". Only when speaking of everyone at once are the agents and the external agents together "the AI workforce" and the people "the human workforce". This holds even if the person says "AI team" or "team" to you.$w$),
    updated_at = NOW()
WHERE system_role = 'caio'
  AND is_system = TRUE;

DO $verify$
DECLARE
  prompt text;
  rest text;
  n integer;
  rule CONSTANT text := '- Say "agent" or "agents", or the agent''s own name, never "AI team" and never "team" on its own: a team is people and agents together. An AI colleague from outside the workspace is an "external agent". The people are "people", "the person" or "members", never "team members". Only when speaking of everyone at once are the agents and the external agents together "the AI workforce" and the people "the human workforce". This holds even if the person says "AI team" or "team" to you.';
BEGIN
  SELECT system_prompt INTO prompt FROM internal_agents WHERE system_role = 'caio' AND is_system = TRUE;

  IF prompt IS NULL THEN
    RAISE EXCEPTION 'migration 564: no seeded Chief AI Officer row to update';
  END IF;

  -- The retired noun is gone from everything EXCEPT the rule that forbids it.
  --
  -- The corrected vocabulary bullet necessarily contains the retired noun
  -- twice, because it names the word it is banning: `never "AI team"` and
  -- `says "AI team"`. Counting the whole prompt therefore finds two and always
  -- will, which is correct output read as failure. The rule is removed first
  -- and the rest must be clean.
  --
  -- Asserting the count outside the bullet rather than allowing "two anywhere"
  -- matters: two stray occurrences elsewhere plus a missing rule would satisfy
  -- a bare count while being the exact failure this migration exists to
  -- prevent.
  rest := replace(prompt, rule, '');
  IF rest = prompt THEN
    RAISE EXCEPTION 'migration 564: the corrected vocabulary rule is not in the prompt';
  END IF;

  n := (length(rest) - length(replace(rest, 'AI team', ''))) / length('AI team');
  IF n <> 0 THEN
    RAISE EXCEPTION 'migration 564: % occurrence(s) of the retired noun survived outside the rule', n;
  END IF;

  n := (length(prompt) - length(replace(prompt, 'external collaborator', ''))) / length('external collaborator');
  IF n <> 0 THEN
    RAISE EXCEPTION 'migration 564: % occurrence(s) of "external collaborator" survived', n;
  END IF;

  -- The collective nouns are KEPT. This is the half of the change that a careless
  -- substitution would have taken out, so it is asserted in the other direction:
  -- their absence is as much a failure as the retired noun's presence.
  n := (length(prompt) - length(replace(prompt, 'the AI workforce', ''))) / length('the AI workforce');
  IF n < 1 THEN
    RAISE EXCEPTION 'migration 564: "the AI workforce" was lost';
  END IF;

  n := (length(prompt) - length(replace(prompt, 'the human workforce', ''))) / length('the human workforce');
  IF n < 1 THEN
    RAISE EXCEPTION 'migration 564: "the human workforce" was lost';
  END IF;

  -- 545's section survives the rename under its new name, which is what says the
  -- substitution edited the prompt rather than replacing it.
  n := (length(prompt) - length(replace(prompt, 'Removing an agent has one name here', ''))) / length('Removing an agent has one name here');
  IF n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 564: expected exactly one removal rule, found %', n;
  END IF;

  -- A prompt this size cannot have been truncated by the eight nested replaces.
  IF length(prompt) < 30000 THEN
    RAISE EXCEPTION 'migration 564: prompt is only % characters; expected at least 30000', length(prompt);
  END IF;
END
$verify$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
