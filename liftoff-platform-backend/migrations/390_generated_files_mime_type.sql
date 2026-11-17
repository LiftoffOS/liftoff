-- Migration 390: record the media type of a generated file.
--
-- Until now the content type of an artifact existed in exactly one place: the
-- GCS object's own metadata, set at upload from an enum lookup on output_type.
-- That is enough to serve the bytes and not enough to decide how to DRAW them:
-- a renderer that has to pick between <img>, <video>, <audio> and a file card
-- needs the MIME before it fetches anything, and reading it back out of GCS on
-- every message render is a round trip per attachment.
--
-- Nullable, and not backfilled. Every row written before this migration is a
-- document whose type is fully determined by output_type, and the read path
-- keeps deriving it there; only 'media' rows depend on this column.

ALTER TABLE generated_files ADD COLUMN IF NOT EXISTS mime_type TEXT;

COMMENT ON COLUMN generated_files.mime_type IS
  'Authoritative content type of the stored object, e.g. image/png. Set on media uploads; NULL on rows whose type is implied by output_type.';
