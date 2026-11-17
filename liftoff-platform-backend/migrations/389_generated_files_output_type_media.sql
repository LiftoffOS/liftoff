-- Migration 389: let the output_type constraint accept everything the API accepts.
--
-- The upload validator (src/generated-files/router.ts) accepts 'pdf' and
-- 'binary'. The CHECK constraint does not: it was last touched in migration 190
-- and still lists five values. The tenant runtime sends exactly the two missing
-- ones — outputType 'pdf' from save_active_browser_page_as_pdf and 'binary' from
-- fetch_browser_download — so without this every browser PDF save and every
-- browser download dies on a 23514 check_violation, after the bytes are already
-- in GCS.
--
-- 'media' is added in the same statement rather than a later one: it is the
-- output type images, video and audio are stored under (see the mime_type
-- column in migration 390), and re-writing this constraint twice would leave a
-- second window where the API accepts a value the table refuses.
--
-- Shaped exactly like migration 190: drop, then re-add with the full list.

ALTER TABLE generated_files
  DROP CONSTRAINT IF EXISTS generated_files_output_type_check;

ALTER TABLE generated_files
  ADD CONSTRAINT generated_files_output_type_check
  CHECK (output_type IN ('xlsx', 'docx', 'docx_redlined', 'pptx', 'gslides', 'pdf', 'binary', 'media'));
