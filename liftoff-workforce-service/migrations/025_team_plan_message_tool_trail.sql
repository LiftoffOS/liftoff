-- 025: what the Chief AI Officer DID in a turn, kept with what it said.
--
-- A person works with the CAIO across one or more conversations — it browses
-- sites, reads what is there, runs capabilities, acts on the data — and then
-- asks for that work to be automated. Turning the work into a standing team
-- needs the trail of what was done, not only the prose that was written about
-- it: the sites, the arguments, the capabilities, the outcomes. The execution
-- loop already gathers every tool call of a turn; until now the chat service
-- kept only the count.
--
-- One JSONB per assistant message: the turn's tool calls in order, each
-- bounded and redacted before it is written, so the column stays a trail and
-- not a copy of every payload. NULL for a turn that called nothing and for
-- every message written before this column existed; readers map both to [].
ALTER TABLE team_plan_messages ADD COLUMN IF NOT EXISTS tool_trail JSONB;

COMMENT ON COLUMN team_plan_messages.tool_trail IS
  'The assistant turn''s tool calls, in order: [{tool, input, outcome}], each '
  'bounded and redacted. NULL when the turn called nothing or predates the column.';
