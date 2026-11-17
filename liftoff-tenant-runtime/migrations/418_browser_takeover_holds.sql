-- 418: the person's own takeover of a thread's browser, and what they did in it.
--
-- A takeover was one bit. `web_sessions.takeover_state` says whether a person
-- holds the keyboard right now, and the control plane's activity row says a
-- browser task hit that state; nothing anywhere recorded WHEN a person took
-- control, when they gave it back, or which pages and controls they used in
-- between. The Chief AI Officer, asked to automate work a person just did in
-- the pane, could see everything except the part the person did themselves.
--
-- browser_takeover_holds is the segment: one row per hold, opened on the
-- none -> taken_over transition, closed by the release, the control plane's
-- absent-driver sweep, the runtime's gate expiry, or the session closing. The
-- open hold per session is unique (browser_takeover_holds_open); a competing
-- start re-reads it rather than opening a second.
--
-- Capture ownership lives on the hold. One process attaches to the session's
-- pages over CDP and installs a recorder in an isolated world; it claims the
-- hold with a lease (capture_owner, capture_generation, capture_lease_until)
-- so that exactly one process records at a time, and a process that dies
-- takes its lease with it. capture_gap records a KNOWN interruption of
-- observation — the recorder was never attached, its owner lost the session,
-- the action cap was reached, or capture was switched off — and only that:
-- false means no known interruption, not proof that every action was seen.
-- gap_reason keeps the FIRST reason recorded; a later interruption sets the
-- flag and nothing over the reason, so every writer uses COALESCE. A release
-- writes only to an OPEN hold: a session close ends the hold before the
-- vendor is told to stop the browser, so the owner's disconnect that follows
-- is the close it is, not an observation lost.
--
-- browser_takeover_actions is what the person did, as a bounded description
-- of the page and the control (url path, tag, role, accessible name, input
-- type). The recorder never reads a form value. A page-authored label or path
-- can still echo one, which is why every reader treats these strings as
-- observed, untrusted data. page_nonce and seq are the recorder's own
-- ordering per execution context and never leave the runtime. The cap of 500
-- actions per hold is enforced by the writer in one transaction (lock the
-- hold, count, insert), not by a CHECK.
--
-- Retention: a hold cascades from its session, so tenant deletion removes
-- these rows through web_sessions. A chat thread's soft delete does not; the
-- control plane's reader refuses a soft-deleted thread, and the rows stay.

CREATE TABLE browser_takeover_holds (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL,
  session_id          UUID NOT NULL REFERENCES web_sessions(id) ON DELETE CASCADE,
  thread_id           UUID,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at            TIMESTAMPTZ,
  end_reason          TEXT CHECK (end_reason IN ('released','absent_driver','expired','session_closed')),
  capture_owner       TEXT,
  capture_generation  INTEGER NOT NULL DEFAULT 0,
  capture_lease_until TIMESTAMPTZ,
  capture_gap         BOOLEAN NOT NULL DEFAULT FALSE,
  gap_reason          TEXT CHECK (gap_reason IN ('lost_owner','cap','disabled','never_attached'))
);
CREATE UNIQUE INDEX browser_takeover_holds_open ON browser_takeover_holds (session_id) WHERE ended_at IS NULL;
CREATE INDEX browser_takeover_holds_thread ON browser_takeover_holds (tenant_id, thread_id, started_at);

CREATE TABLE browser_takeover_actions (
  hold_id     UUID NOT NULL REFERENCES browser_takeover_holds(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL,
  generation  INTEGER NOT NULL,
  page_nonce  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  kind        TEXT NOT NULL CHECK (kind IN ('navigate','click','submit','change','enter')),
  url         TEXT NOT NULL,
  tag         TEXT,
  role        TEXT,
  name        TEXT,
  input_type  TEXT,
  PRIMARY KEY (hold_id, page_nonce, seq)
);

-- Tenant policy as migration 410 writes it, FORCEd so the owning role is
-- bound by it too; every query runs under withTenantScope.
ALTER TABLE browser_takeover_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE browser_takeover_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY browser_takeover_holds_tenant ON browser_takeover_holds
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE browser_takeover_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE browser_takeover_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY browser_takeover_actions_tenant ON browser_takeover_actions
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMENT ON TABLE browser_takeover_holds IS
  'One takeover of a thread''s browser by a person: opened on none -> taken_over, ended by release, absent-driver sweep, gate expiry or session close. Capture ownership (owner, generation, lease) decides which process records; capture_gap records a KNOWN interruption of observation only.';
COMMENT ON TABLE browser_takeover_actions IS
  'What the person did while driving: a bounded description of the page and control, never a form value. A page-authored label or path can still echo one; readers treat these as observed, untrusted data. 500 per hold, enforced by the writer.';
