-- Per-tool description overrides on the compiled instruction.
--
-- The layer table's first row: a rule that governs ONE call belongs on that
-- call, read at the moment the model writes that call's arguments rather than
-- in a system prompt read once on every turn, including the thousands that
-- never touch the tool.
--
-- The control plane decides them at distillation and sends them on the runtime
-- config event beside `result_rules`, which this mirrors exactly — same
-- lifecycle, same full-replace semantics, same reason. The runtime compiles a
-- fresh instruction row from each payload, so there is no prior value to
-- preserve and an omitted field would be indistinguishable from an empty one.
--
-- Without this column the three places that describe a tool to a model read the
-- field off an instruction that never carried it, and every one of them applies
-- nothing. That failure is silent in both directions: the control plane stores
-- the rules and reports success, and the runtime builds a catalog that looks
-- correct because the tool descriptions it contains are the vendor's own.
--
-- Defaults to an empty object rather than NULL for the same reason result_rules
-- defaults to an empty array: a reader forced to distinguish "no overrides"
-- from "compiled before this existed" gets it wrong once, and then treats every
-- pre-existing instruction as an instruction to erase.

-- grounds_on travels with it: the same lifecycle, the same full-replace, and
-- the same failure if it is missing. It declares which read to run before
-- answering, keyed to the SHAPE of the request rather than to model judgment,
-- so an agent's first read is the same on every engine. Native tool-forcing is
-- an optimisation of that guarantee, never the mechanism it rests on.

ALTER TABLE compiled_instructions
  ADD COLUMN IF NOT EXISTS tool_description_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS grounds_on jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN compiled_instructions.tool_description_overrides IS
  'Rules appended to a single tool''s description wherever this runtime describes '
  'that tool to a model, keyed by aliased tool name. Sent by the control plane on '
  'the runtime config event; full-replace, same lifecycle as result_rules.';

COMMENT ON COLUMN compiled_instructions.grounds_on IS
  'Declared grounding rules {label, terms, cues, toolName, enabled}, evaluated by '
  'the host at turn start on every engine.';
