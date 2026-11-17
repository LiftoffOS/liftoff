-- 436: the files a browser session downloaded, on every vendor.
--
-- Downloads were Anchor's alone. Anchor keeps a download store and answers a
-- listing endpoint, and `list_browser_downloads` / `fetch_browser_download`
-- called it; on Steel, Browser Use and Browserbase both tools refused, so
-- "the file I just downloaded" was answerable on one of the four browsers a
-- session can run on. Asked to bring a generated video into the chat on a
-- Steel pane, the assistant had no tool that could, so it would try to read
-- the address out of the page instead and end up delivering a screenshot.
--
-- A download is a browser event before it is a vendor feature. Chromium
-- announces one on the session's own CDP connection, with the address it is
-- fetching and the name it would save; this table is that announcement, and
-- the bytes are fetched from the page when somebody asks for them, so nothing
-- here depends on a vendor's filesystem or its API.
--
-- One row per download, per session. `url` is the address the browser was
-- fetching, which is what a later fetch replays from inside the page so the
-- session's own cookies apply. No bytes are stored here: this is a record of
-- what happened, and the file itself becomes a generated file only when it is
-- asked for.
--
-- Retention: a download cascades from its session, so a tenant's deletion
-- removes these rows through web_sessions.

CREATE TABLE browser_session_downloads (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL,
  session_id          UUID NOT NULL REFERENCES web_sessions(id) ON DELETE CASCADE,
  -- The address the browser was fetching. Bounded and sanitized before it
  -- lands, as every recorded URL in this estate is.
  url                 TEXT NOT NULL,
  url_truncated       BOOLEAN NOT NULL DEFAULT FALSE,
  url_protected_data_omitted BOOLEAN NOT NULL DEFAULT FALSE,
  -- What the browser would have called the file.
  suggested_file_name TEXT NOT NULL DEFAULT '',
  -- The page the download started from, for the model's sense of where it
  -- came from.
  origin_url          TEXT NOT NULL DEFAULT '',
  created_at          TIMESTAMPTZ(3) NOT NULL DEFAULT NOW()
);
CREATE INDEX browser_session_downloads_session ON browser_session_downloads (session_id, created_at DESC);
CREATE UNIQUE INDEX browser_session_downloads_once
  ON browser_session_downloads (session_id, url, suggested_file_name);

-- Tenant policy as migrations 423 and 431 write it, FORCEd so the owning role
-- is bound by it too; every query runs under withTenantScope.
ALTER TABLE browser_session_downloads ENABLE ROW LEVEL SECURITY;
ALTER TABLE browser_session_downloads FORCE ROW LEVEL SECURITY;
CREATE POLICY browser_session_downloads_tenant ON browser_session_downloads
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMENT ON TABLE browser_session_downloads IS
  'A file a browser session downloaded, recorded from the session''s own CDP connection so every vendor is covered rather than Anchor alone. No bytes: the file is fetched from inside the page when it is asked for, so the session''s cookies apply.';
COMMENT ON COLUMN browser_session_downloads.url IS
  'The address the browser was fetching, replayed from inside the page when the file is asked for.';
COMMENT ON COLUMN browser_session_downloads.suggested_file_name IS
  'What the browser would have saved it as; the name the file card carries unless the fetch learns a better one.';
