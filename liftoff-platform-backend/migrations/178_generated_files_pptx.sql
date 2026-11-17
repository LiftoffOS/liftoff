BEGIN;

-- Allow gcs_path to be NULL for connector-native files (e.g. Google Slides presentations
-- that live in the user's Google Drive and have no GCS record).
ALTER TABLE generated_files
  ALTER COLUMN gcs_path DROP NOT NULL;

-- Extend the output_type check constraint to include 'pptx'.
ALTER TABLE generated_files
  DROP CONSTRAINT IF EXISTS generated_files_output_type_check;

ALTER TABLE generated_files
  ADD CONSTRAINT generated_files_output_type_check
  CHECK (output_type IN ('xlsx', 'docx', 'docx_redlined', 'pptx'));

COMMIT;
