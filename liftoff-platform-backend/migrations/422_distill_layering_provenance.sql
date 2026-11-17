-- Two configuration artifacts distillation produces and had nowhere to put:
-- per-tool description overrides, and the decision record.
--
-- BOTH ARE CONFIGURATION PROVENANCE, which is why they land together. The agent
-- row already holds WHAT the agent is; neither of these changes that. They hold
-- which layer a rule was put in, and which decisions a human already made — the
-- two things a redistill needs in order to be a merge rather than a rewrite.
--
-- tool_description_overrides: rules read while ONE call's arguments are written,
-- keyed by tool name. The layer table's first row. They are stored rather than
-- folded into the system prompt precisely so they can be applied per tool at the
-- point the runtime assembles its catalog: a rule about writing a review comment
-- is read when that comment is being written, not on every turn of every
-- conversation including the ones that never touch the tool.
--
-- decision_record: the trigger choice and why, the cadence clamps that were
-- applied, the capability tri-states, and the assumptions made for inputs nobody
-- answered. Written by distillation, read back by the NEXT distillation as a
-- section it must honour and diff against.
--
-- The failure that motivates it is not hypothetical and is worst in the
-- conversational build loop: a user says "this agent has no email", the
-- distiller records that as prose, and the next "tweak my agent" re-litigates it
-- because prose is not a decision — it is a sentence a later generation is free
-- to rewrite. Recorded here, a refinement becomes a merge against what the user
-- already settled, which is the ADR-043 skill-provenance discipline applied to
-- configuration instead of to skills.
--
-- Both DEFAULT to an empty object rather than NULL. A reader that has to
-- distinguish "no overrides" from "never distilled" would get it wrong once and
-- then treat every legacy row as an instruction to erase.

-- grounds_on: which read to run before answering, keyed to the SHAPE of the
-- request rather than to model judgment. Derived from the bound read tools at
-- distillation and evaluated by the runtime on every engine, so an agent's first
-- read is the same wherever it runs. Native tool-forcing, where a vendor offers
-- it, is an optimisation of this rather than the mechanism it depends on.

ALTER TABLE internal_agents
  ADD COLUMN IF NOT EXISTS tool_description_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS decision_record jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS grounds_on jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN internal_agents.tool_description_overrides IS
  'Per-tool rules appended to that tool''s description when the runtime assembles '
  'its catalog. Keyed by catalog tool name. The layer table''s first row: a rule '
  'governing one call lives on that call.';

COMMENT ON COLUMN internal_agents.decision_record IS
  'Configuration provenance: trigger choice and why, cadence clamps applied, '
  'capability tri-states, and assumptions made for unanswered inputs. A redistill '
  'reads this as a section it must honour and diffs against it, so a human '
  'decision is merged rather than silently reversed.';

COMMENT ON COLUMN internal_agents.grounds_on IS
  'Declared grounding rules: {label, terms, cues, toolName, enabled}. The host '
  'evaluates these at turn start on every engine and prefetches the named read, '
  'so an agent''s first read does not depend on which vendor is serving it.';
