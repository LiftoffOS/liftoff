-- web_profiles metadata for "default to profiles":
--   owner_account_id     — the human who owns this login. Stamped by both the
--                          pane capture and explicit web_session_save, and used
--                          to scope web_session_list / web_session_forget so one
--                          user cannot see or revoke another user's logins.
--   agent_id             — the agent that created this login. List/forget are
--                          scoped to (owner, agent) so a narrow agent cannot
--                          discover or revoke another agent's saved logins —
--                          the same capability-scoping principle the per-agent
--                          connector binding already enforces. NULL = legacy /
--                          tenant-shared (pre-migration rows).
--   last_used_at         — set ONLY on genuine reuse (a profile attached to a
--                          session for real work), never on create. List
--                          ordering uses COALESCE(last_used_at, created_at).
--   service_name/login_url — friendly labels for a saved (per-site) login.
--   dedicated_sticky_ip  — visibility for the Anchor sticky-IP we request on
--                          deliberately-saved logins (reduces re-login/lockouts).
--   profile_kind         — 'saved' = a deliberate, per-site, named login created
--                          via web_session_save (sticky IP, friendly labels).
--                          'pane'  = the per-(tenant,agent,owner) browser profile
--                          the live-view pane persists; one per user, may hold
--                          many site logins, machine-named. The two are surfaced
--                          differently by web_session_list.
-- All additive + nullable/defaulted → safe online. Applied by Cloud Build.
ALTER TABLE web_profiles
  ADD COLUMN owner_account_id    UUID,
  ADD COLUMN agent_id            UUID,
  ADD COLUMN last_used_at        TIMESTAMPTZ,
  ADD COLUMN service_name        TEXT,
  ADD COLUMN login_url           TEXT,
  ADD COLUMN dedicated_sticky_ip BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN profile_kind        TEXT NOT NULL DEFAULT 'saved'
    CHECK (profile_kind IN ('saved', 'pane'));

CREATE INDEX IF NOT EXISTS web_profiles_tenant_owner_agent_idx
  ON web_profiles (tenant_id, owner_account_id, agent_id);
