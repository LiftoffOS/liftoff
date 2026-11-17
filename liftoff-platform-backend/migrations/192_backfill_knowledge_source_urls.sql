-- Backfill source_url for knowledge_items whose URL came back null from the
-- connector-service browse path. Three connectors are deterministic from
-- columns we already have:
--
--   google_drive → https://drive.google.com/open?id={external_id}
--                  Drive redirects this universal link to the right viewer
--                  (Docs/Sheets/Slides/binary) based on the file's mime type.
--
--   box          → https://app.box.com/{file|folder}/{external_id}
--                  Box uses stable ID URLs; the `/file/{id}` and
--                  `/folder/{id}` paths resolve for any authenticated user
--                  with access.
--
--   dropbox      → https://www.dropbox.com/{preview|home}{metadata.path}
--                  We persisted path_display in metadata.path at import
--                  time. /preview shows the file viewer; /home shows the
--                  folder listing.
--
-- atlassian_confluence is intentionally NOT backfilled here: the user-
-- facing URL requires the Atlassian site URL, which lives in the connector
-- credentials vault (not in this database). If/when Confluence-affected
-- rows surface, a separate one-shot script that calls the connector-
-- service will handle them.

UPDATE knowledge_items
SET source_url = 'https://drive.google.com/open?id=' || external_id,
    updated_at = NOW()
WHERE connector_type = 'google_drive'
  AND source_url IS NULL
  AND external_id IS NOT NULL;

UPDATE knowledge_items
SET source_url = CASE
      WHEN content_type IN ('folder', 'collection')
        THEN 'https://app.box.com/folder/' || external_id
      ELSE 'https://app.box.com/file/' || external_id
    END,
    updated_at = NOW()
WHERE connector_type = 'box'
  AND source_url IS NULL
  AND external_id IS NOT NULL;

UPDATE knowledge_items
SET source_url = CASE
      WHEN content_type IN ('folder', 'collection')
        THEN 'https://www.dropbox.com/home' || (metadata->>'path')
      ELSE 'https://www.dropbox.com/preview' || (metadata->>'path')
    END,
    updated_at = NOW()
WHERE connector_type = 'dropbox'
  AND source_url IS NULL
  AND metadata ? 'path'
  AND (metadata->>'path') IS NOT NULL;
