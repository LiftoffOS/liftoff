-- Migration 190: Extend output_type constraint to include 'gslides'.
--
-- Google Slides presentations created natively via the connector do not have a
-- file extension. Using a distinct output_type ('gslides') lets the backend
-- omit the extension from the stored filename (e.g. "Deck_v1" not "Deck_v1.pptx").

ALTER TABLE generated_files
  DROP CONSTRAINT IF EXISTS generated_files_output_type_check;

ALTER TABLE generated_files
  ADD CONSTRAINT generated_files_output_type_check
  CHECK (output_type IN ('xlsx', 'docx', 'docx_redlined', 'pptx', 'gslides'));
