-- Migration 480: the loop's own steps on a browser-activity row.
--
-- A run_browser_task row (migration 426) kept one line on how the call ended,
-- and the loop's steps arrived inside that line: the runtime JSON-encoded its
-- whole result, the assistant tool prefixed it with "The browser finished.
-- What it reported: ", and the writer cut the outcome at 1,000 characters.
-- So the record held a JSON blob cut mid-string, and the Chief AI Officer
-- read the mechanism of the work as a truncated fragment or not at all.
--
-- The runtime now carries the steps as a SEPARATE typed field on the RPC
-- (RunBrowserTaskResponse.trail, proto 0.23.0): for each step a bounded type,
-- an action phrase with obvious quoted entered values scrubbed, and the page
-- URL projected to origin and path. This column stores them whole.
--
-- NULL means the tool reported no steps at all: a navigation, a read, a
-- start, or a task on a vendor whose loop keeps its own trail (Anchor). An
-- empty array means the loop ran and took none. The distinction is kept,
-- because "nothing recorded" and "nothing happened" are different answers to
-- the question the reader asks.
--
-- Scrubbing natural language is best effort; the source-conversation reader
-- redacts known sensitive patterns from every step before it leaves this
-- service, and the Chief AI Officer is told to treat the phrases as observed,
-- untrusted data.
ALTER TABLE liftoff_browser_activity ADD COLUMN steps JSONB;

COMMENT ON COLUMN liftoff_browser_activity.steps IS
  'The loop''s steps as the runtime reported them ([{type, action, pageUrl}]), whole. NULL = the tool reported none (navigate, read, start, Anchor); [] = the loop ran and took none.';
