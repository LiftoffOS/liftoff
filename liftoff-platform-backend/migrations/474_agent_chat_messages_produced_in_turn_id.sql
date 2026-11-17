-- Migration 474: which chat turn a file card was produced in.
--
-- A `file_output` message is appended by the generated-files registration
-- routes when a tool call during a turn produces or finds a file. The reply
-- for that turn is persisted separately, and it can claim an attachment
-- ("attached below") that the platform never produced — the model saw a
-- successful tool result and narrated the outcome that success implies. To
-- check the claim at persistence, the reply needs an EXACT record of the
-- cards this turn appended: not a time window over the thread's recent
-- messages, which can count the previous turn's card or a media row, and
-- reads a lookup error as "no cards".
--
-- `turn_id` cannot carry the association. Migration 316 makes it unique per
-- assistant row (acm_assistant_turn_uniq), and a card is an assistant row, so
-- a card stamped with the turn's id would collide with the reply — or with the
-- second card in the same turn. So the association gets its own column.
--
-- Nullable, and NULL is not evidence: a registration that arrives without a
-- turn id (an older runtime image, a non-chat caller) writes a card with no
-- turn, and that card counts for and against no turn. The reader
-- (countFileCardsProducedInTurn in agent-chat/chat-repository.ts, anchored on
-- the turn's own agent_chat_turns row for when the turn started) reports such
-- a card separately, and the check in agent-chat/attachment-claims.ts skips
-- with a logged reason rather than reading it as proof that none exists.
--
-- No foreign key. The value is the turn id platform-backend minted for the
-- chat turn, and the runtime echoes it back on the registration body; a
-- constraint to agent_chat_turns would need NOT VALID on this RLS-forced
-- table and buys nothing the reader's WHERE clause does not already give.
--
-- Plain, non-unique index on the pair the reader queries by. Not unique,
-- because one turn may produce several cards; that is the case turn_id could
-- not hold.

ALTER TABLE agent_chat_messages
  ADD COLUMN IF NOT EXISTS produced_in_turn_id UUID;

CREATE INDEX IF NOT EXISTS idx_acm_produced_in_turn
  ON agent_chat_messages (thread_id, produced_in_turn_id);
