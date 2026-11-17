-- Give the skill-usefulness signal an evidence count, and make plain which
-- surface the score belongs to.
--
-- Why:
--
-- `agent_skills.usefulness_score` has two consumers — the retrieval re-rank in
-- skills/retrieval.ts (weight 0.2) and the reflection prompt in
-- infrastructure/vertex-ai.ts, where `usefulness_score <= 0` is what UNLOCKS a
-- skill-description rewrite. It has exactly one writer:
-- agent-execution/skill-learning.ts, on the autonomous path only, with the
-- delta `toolCallsExecuted > 0 ? +1 : -1`.
--
-- Interactive chat retrieves skills on every turn and settles nothing, so for a
-- chat-dominant agent the re-rank term was structurally zero while the formula
-- claimed to weight it.
--
-- The tempting fix — settle chat with the same delta — is the one thing we must
-- not do. Most chat turns legitimately execute zero tools (the user asks, the
-- agent answers), so the autonomous delta would decrement on ordinary
-- conversation, push scores through zero, and hand the reflection engine
-- permission to rewrite the descriptions of skills that are working.
--
-- The second tempting fix — a `usefulness_chat` column — was written and then
-- removed before shipping. Nothing can write it: chat's only honest signal is
-- explicit thumbs feedback, and resolving that back to the skills injected for
-- a given turn needs a per-turn skill record that does not exist. A column with
-- a reader and no writer is exactly the defect the schema-reachability gate in
-- platform-backend exists to catch, and adding one here while building that
-- gate would have been absurd. Chat therefore drops the usefulness term
-- outright (see skills/retrieval.ts) and ranks on similarity + tags, which is
-- what it was already doing in practice — only now it says so.
--
-- `observation_count` is the evidence counter, and it is fully wired: written
-- by skill-learning.ts on every settled autonomous run, read by the reflection
-- gate. A skill injected three times and unlucky twice currently satisfies
-- `<= 0` and becomes re-writable; the gate now also requires that we have
-- watched it often enough for the score to mean anything.

ALTER TABLE agent_skills
  ADD COLUMN IF NOT EXISTS observation_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN agent_skills.usefulness_score IS
  'Usefulness accrued on the AUTONOMOUS execution surface only. Written by '
  'agent-execution/skill-learning.ts. Interactive chat neither writes nor '
  'ranks on it — chat has no honest per-skill signal, so it ranks on '
  'similarity and tags instead. Retained under its original name so existing '
  'history survives; a rename would break in-flight revisions during a rollout.';

COMMENT ON COLUMN agent_skills.observation_count IS
  'Settled autonomous runs that have contributed to usefulness_score. Gates the '
  'reflection engine: usefulness_score <= 0 only unlocks a description rewrite '
  'once there is enough evidence for the score to be meaningful. Counts runs '
  'watched, not runs that went well, so it rises on both +1 and -1.';
