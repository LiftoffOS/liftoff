-- Durable cross-cycle resume token for connectors that have no server-side
-- `since` filter and no newest-first sort, but DO expose a durable incremental
-- token/cursor (e.g. Ashby syncToken, Instantly starting_after). The poller
-- persists this token across cycles and resumes from it, so it never re-scans
-- from the oldest record (which would truncate at MAX_PAGES and silently lose
-- new records for large accounts). Distinct from last_page_token, which is
-- within-cycle pagination only.
ALTER TABLE connector_sync_state
  ADD COLUMN IF NOT EXISTS last_sync_cursor TEXT;
