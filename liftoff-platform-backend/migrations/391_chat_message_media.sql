-- Migration 391: a carrier for media on every chat surface.
--
-- MediaRef[] — { mediaId, mimeType, filename, sizeBytes?, width?, height?,
-- durationMs?, alt? } — one shape, one column name, on all three message
-- tables platform-backend owns.
--
-- Deliberately NOT `attachments`. That column already exists on two of these
-- tables and means OPPOSITE things on them: on agent_chat_messages it is what
-- the team produced, on liftoff_chat_messages it is what the person sent.
-- Reusing it would render agent media as user upload pills on Liftoff, and
-- insights_chat_messages has no such column at all. Media gets its own name so
-- neither existing meaning has to move.
--
-- Deliberately NOT `visualization_blocks` either: that is the Insights and CAIO
-- content model, those surfaces are meant to differ, and extending it would
-- force a parser, prompt and renderer change on surfaces that asked for none.
--
-- All three columns land together because the migration is additive and free.
-- Only a surface with a media PRODUCER gets wired; the others gain the
-- capability without any change to what they display.

ALTER TABLE agent_chat_messages    ADD COLUMN IF NOT EXISTS media JSONB;
ALTER TABLE liftoff_chat_messages  ADD COLUMN IF NOT EXISTS media JSONB;
ALTER TABLE insights_chat_messages ADD COLUMN IF NOT EXISTS media JSONB;

COMMENT ON COLUMN agent_chat_messages.media IS
  'MediaRef[] the team produced for this message: images, video, audio. Referenced by generated_files.id, never embedded. NULL when the message carried none.';
COMMENT ON COLUMN liftoff_chat_messages.media IS
  'MediaRef[] the reply produced for this message. Same shape and same name as agent_chat_messages.media.';
COMMENT ON COLUMN insights_chat_messages.media IS
  'MediaRef[] the reply produced for this message. Same shape and same name as agent_chat_messages.media.';
