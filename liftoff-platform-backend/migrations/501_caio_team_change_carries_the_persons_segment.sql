-- Migration 501: a change handed over from a team's chat carries the
-- person's own browser segment, not only what the AI team did.
--
-- The failure this closes: a person has the team open a page, then drives
-- the pane themselves through two more pages and a sign-in form, and asks
-- the team to "automate what I just did". The team forwards the request in
-- its own words ("go to the page and summarize what you can see"), which is
-- all the team itself did. The Chief AI Officer reads the team's
-- conversation and its browser trail, receives the whole segment (the
-- pages, the controls, and the sign-in fields as omitted), and then drafts
-- from the forwarded sentence alone, writing "no sign-in" instead of asking
-- the sign-in question rule 5 requires. The paragraph told it to draft "the
-- smallest update that carries what they asked", and nothing said that the
-- forwarded text is the AI team's paraphrase rather than the specification.
--
-- One text change, on an anchor that occurs exactly once as migrations 1 to
-- 500 leave the prompt: the team-change paragraph now says that the
-- forwarded request was written by the AI team from what it did itself,
-- that "what I just did" spans the person's own segments in the trail, and
-- that the fidelity rules, rule 5 included, govern the change. The DO block
-- raises unless the new text appears exactly once and the old anchor zero
-- times.
--
-- RLS: as 482, 484, 488 and 500; required by scripts/ci-fences/system-agent-rls-fence.sh.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

UPDATE internal_agents
SET system_prompt = replace(
      system_prompt,
      $Ho$call `source_conversation__read` first, which returns that team's conversation and its browser trail, the person's own segments included; the rules of "Building from work already done" apply to what it returns, draft the smallest update that carries what they asked,$Ho$,
      $Hn$call `source_conversation__read` first, which returns that team's conversation and its browser trail, the person's own segments included. The request the AI team forwarded was written by the AI team from what it did itself; it is not the specification. The specification is the trail: "what I just did" spans the person's own segments as much as the AI team's steps, and the rules of "Building from work already done" apply to all of it, rule 5 included, so a segment the person drove goes into the AI team's steps in order, and a sign-in or other protected step in it is asked about in that one question, never dropped and never described as absent. Draft the smallest update that carries that,$Hn$
    ),
    updated_at = NOW()
WHERE system_role = 'caio'
  AND is_system = TRUE;

DO $verify$
DECLARE
  prompt text;
  n integer;
BEGIN
  SELECT system_prompt INTO prompt FROM internal_agents WHERE system_role = 'caio' AND is_system = TRUE;
  IF prompt IS NULL THEN
    RAISE EXCEPTION 'migration 501: no Chief AI Officer system row';
  END IF;
  n := (length(prompt) - length(replace(prompt, 'The request the AI team forwarded was written by the AI team from what it did itself; it is not the specification.', ''))) / length('The request the AI team forwarded was written by the AI team from what it did itself; it is not the specification.');
  IF n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 501: expected exactly one of the forwarded-request sentence, found %', n;
  END IF;
  n := (length(prompt) - length(replace(prompt, 'never dropped and never described as absent. Draft the smallest update that carries that,', ''))) / length('never dropped and never described as absent. Draft the smallest update that carries that,');
  IF n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'migration 501: expected exactly one of the smallest-update sentence, found %', n;
  END IF;
  IF position('apply to what it returns, draft the smallest update that carries what they asked,' IN prompt) > 0 THEN
    RAISE EXCEPTION 'migration 501: the old team-change sentence is still present';
  END IF;
END
$verify$;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
