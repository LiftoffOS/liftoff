-- Migration 392: Insights gains user-sent attachments, matching Liftoff.
--
-- The affordance already exists on the page: InsightsPage renders the file
-- upload button, the composer shows the pill, and the client puts the field in
-- the request body. The server has never had anywhere to put it — the router,
-- chat service and repository contain zero references to attachments — so a
-- person can attach a CSV to an Insights question, watch it accepted, and have
-- it silently dropped before the model ever sees it.
--
-- METADATA ONLY, for the reason migration 348 records for liftoff_chat_messages:
-- an upload's extracted text is a one-turn model input, not transcript, and
-- eight of them at 4000 characters each would put a second copy of every
-- document into this table. Nullable and sparse, since most messages carry
-- nothing; the repository reads NULL back as an empty list.

ALTER TABLE insights_chat_messages ADD COLUMN IF NOT EXISTS attachments JSONB;

COMMENT ON COLUMN insights_chat_messages.attachments IS
  'Metadata for what the person attached when sending: { kind, name, connectorType?, connectorId?, externalId?, sourceUrl? }. Never the upload body. Same meaning and shape as liftoff_chat_messages.attachments.';
