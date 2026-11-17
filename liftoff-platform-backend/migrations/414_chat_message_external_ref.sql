-- An idempotency key for a chat message that belongs to no turn.
--
-- The escalation-thread route needs one: it is called by a Cloud Tasks
-- consumer, so a redelivery of the same escalation must not append the same
-- message twice. It used `turn_id` for that, against the partial unique index
-- acm_assistant_turn_uniq.
--
-- `turn_id` is a foreign key into agent_chat_turns (migration 294), and an
-- escalation id is not a turn id. So EVERY call through that route violated the
-- constraint and the route never wrote a row — not for an escalation, and not
-- for the `delivery` variant added on top of it in August. Both callers treat
-- the failure as non-fatal and log a warning, which is why it was invisible for
-- six weeks: two shipped features that had never once worked.
--
-- Not fixed by synthesising a turn. A turn carries sender_account_id and feeds
-- idx_turns_recall and the embedding sweep — it is the unit of CONVERSATION
-- recall. A fake turn for a message nobody asked for would put a
-- non-conversation into what the team remembers, which is a worse defect than
-- the one it fixes.
--
-- So the key lives on the message, where it belongs, and references nothing.

ALTER TABLE agent_chat_messages
  ADD COLUMN IF NOT EXISTS external_ref TEXT;

-- Scoped by tenant because the ref is composed by the caller
-- (`<kind>:<escalationId>`) and only has to be unique where it is used.
-- Partial, so the column costs nothing for the messages that have no ref —
-- which is nearly all of them.
CREATE UNIQUE INDEX IF NOT EXISTS acm_external_ref_uniq
  ON agent_chat_messages (tenant_id, external_ref)
  WHERE external_ref IS NOT NULL;
