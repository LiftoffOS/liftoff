-- Migration 023: the Chief AI Officer's messages can carry media.
--
-- MediaRef[] — { mediaId, mimeType, filename, sizeBytes?, width?, height?,
-- durationMs?, alt? } — the same shape, under the same column name, as
-- agent_chat_messages.media, liftoff_chat_messages.media and
-- insights_chat_messages.media in platform-backend (its migration 391). One
-- name and one shape is what lets a single frontend renderer draw all four
-- surfaces; a fourth spelling here would be a fourth thing to keep in step.
--
-- Its producer is images a PERSON uploads into the conversation, which are
-- displayed rather than merely listed as a filename. The read path is in place,
-- so the carrier is end-to-end and a writer needs no schema change on a live
-- table.
--
-- Deliberately NOT `attachments` (added in migration 022). That column is what
-- the person SENT, kept as metadata with the upload's text dropped; this one is
-- what the conversation carries to be LOOKED AT, and the bytes live in the
-- platform's object storage behind a signed URL minted at render time. Two
-- meanings, two columns, so neither has to bend.
--
-- Nullable and sparse, like `visualization_blocks` and `attachments` beside it:
-- most messages carry nothing, which is what every row written before this
-- migration reads back as, and the repository maps NULL to an empty list.
--
-- team_plan_messages is tenant-scoped through its thread and carries RLS, but
-- ADD COLUMN is a schema change rather than a row write, so it needs none of the
-- FORCE / NO FORCE handling a data migration on a policied table would.

ALTER TABLE team_plan_messages
  ADD COLUMN IF NOT EXISTS media JSONB;

COMMENT ON COLUMN team_plan_messages.media IS
  'MediaRef[] the conversation carries to be displayed: images, video, audio. Referenced by the platform generated-files id, never embedded. Same shape and name as platform-backend''s *_chat_messages.media. NULL when the message carried none.';
