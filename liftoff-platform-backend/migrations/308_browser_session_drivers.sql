-- Which human currently has the wheel on a browser session.
--
-- tenant-runtime already tracks *that* a human took control
-- (web_sessions.takeover_state, set by pauseSession, and enforced against the
-- agent at tool dispatch). It does not track *who*, which is enough when the
-- only two parties are "the agent" and "a user", and not enough once a thread
-- has several people in it: the observers cannot be told whose session they are
-- watching, and control cannot be handed back to a named person.
--
-- Kept here rather than on web_sessions deliberately. Adding the column there
-- would mean a proto change to PauseSessionRequest, a liftoff-proto release,
-- and a coordinated deploy of two services, to carry an account id that only
-- the control plane can resolve to a person anyway. The split mirrors how
-- `owner` is already attached to session payloads: tenant-runtime owns
-- enforcement, the control plane owns attribution.
--
-- Not a source of truth for whether the session is taken over — takeover_state
-- remains that. A row here without takeover_state is meaningless; the read path
-- treats takeover_state as authoritative and uses this only to name the driver.

CREATE TABLE browser_session_drivers (
  session_id UUID PRIMARY KEY,
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  account_id UUID NOT NULL REFERENCES accounts(id),
  taken_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- No FK to web_sessions: that table lives in the tenant-runtime database.
-- Rows are cleaned up on release, and orphans are harmless because the read
-- path only consults this when takeover_state says a human holds control.
CREATE INDEX idx_bsd_tenant ON browser_session_drivers (tenant_id);

ALTER TABLE browser_session_drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE browser_session_drivers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON browser_session_drivers
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
