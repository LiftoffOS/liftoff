-- Migration 473: the output_type constraint accepts 'gdoc'.
--
-- A native Google Doc is the sibling of 'gslides': a file that lives in the
-- connector, has no bytes here and no extension. The tenant runtime has sent
-- outputType 'gdoc' for a Google Doc it copied and edited in the user's Drive
-- since that tool shipped, and the registration route's zod enum has never
-- held the value — a 400 before the row was reached, and a card that never
-- appeared. The enum gains the member in src/generated-files/store.ts in the
-- same change.
--
-- The enum alone would not do: this column carries a CHECK constraint
-- mirroring it (last written by migration 389), so a value the validator
-- accepts and the table refuses turns today's 400 into a 23514 one layer
-- deeper, with the same silent fallback on the sender's side. The unit test
-- beside the store (output-type-constraint.test.ts) reads the LAST clause
-- written for this constraint and compares it to the enum, so the two cannot
-- drift again without failing the build.
--
-- Shaped exactly like migrations 190 and 389: drop, then re-add with the
-- full list. Never edit 389 — it is applied everywhere.

ALTER TABLE generated_files
  DROP CONSTRAINT IF EXISTS generated_files_output_type_check;

ALTER TABLE generated_files
  ADD CONSTRAINT generated_files_output_type_check
  CHECK (output_type IN ('xlsx', 'docx', 'docx_redlined', 'pptx', 'gslides', 'gdoc', 'pdf', 'binary', 'media'));
