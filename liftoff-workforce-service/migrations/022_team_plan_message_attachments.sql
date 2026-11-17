-- Migration 022: the Chief AI Officer can be given a file.
--
-- The affordance is already on the page. TeamPlanPage renders the upload
-- button, the composer shows the pill, and the client PUTS THE FIELD IN THE
-- REQUEST BODY. This service has never had anywhere to receive it: the
-- chat-stream router's zod schema destructures only threadId, content and
-- forwardedContext, and zod strips unknown keys, so `attachments` was dropped on
-- arrival without an error, and the whole repository contained zero references
-- to it. A person could attach a CSV to a plan question, watch it accepted, and
-- have it silently discarded before the model ever saw it.
--
-- METADATA ONLY, on the terms platform-backend's migration 348 records for
-- liftoff_chat_messages: an upload's extracted text is a one-turn model input,
-- not transcript, and eight of them at 4000 characters each would put a second
-- copy of every document into this table. What is stored is enough to draw the
-- chip again on reload — kind, name, and a connector reference's identifiers.
--
-- Nullable and sparse, like `visualization_blocks` and `message_type` beside it:
-- most messages carry nothing, which is what every row written before this
-- migration reads back as, and the repository maps NULL to an empty list.
--
-- team_plan_messages is tenant-scoped through its thread and carries RLS, but
-- ADD COLUMN is a schema change rather than a row write, so it needs none of the
-- FORCE / NO FORCE handling a data migration on a policied table would.

ALTER TABLE team_plan_messages
  ADD COLUMN IF NOT EXISTS attachments JSONB;
