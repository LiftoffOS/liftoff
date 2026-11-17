-- Migration 489: RFC 7592 client registration management for the MCP OAuth
-- front door (migration 291).
--
-- A DCR client (RFC 7591) can deprovision its own registration: DELETE on
-- the registration_client_uri, authenticated by the registration access
-- token issued once, at registration. Two columns on the platform-global,
-- non-RLS oauth_clients table:
--
--   registration_access_token_hash — the sha256 of the token, the same
--     hashed custody as every other secret in this family. NULL for the
--     registrations made before this existed (the RFC returns the fields
--     only when the server issues them, so those clients cannot manage
--     themselves) and for CIMD clients, whose client_id is a URL shared by
--     every user of the tool.
--   deleted_at — the soft-delete stamp. A deleted client is unknown to
--     /oauth/authorize and /oauth/device_authorization, and no grant can be
--     approved for it; the row stays so its grants' foreign keys hold and a
--     late poll still reads its outcome.
--
-- Pure DDL: nothing here reads or writes a row, no FK, and no revoking
-- statement (INV-PB-014) — a deploy never invalidates a credential.
ALTER TABLE oauth_clients
  ADD COLUMN IF NOT EXISTS registration_access_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

COMMENT ON COLUMN oauth_clients.registration_access_token_hash IS
  'RFC 7592: sha256 of the registration access token issued at DCR, the one credential that can DELETE this registration. NULL for pre-existing and CIMD clients, which cannot manage themselves.';
COMMENT ON COLUMN oauth_clients.deleted_at IS
  'RFC 7592: set when the client deprovisioned its own registration. A deleted client is unknown to the authorize and device endpoints and no grant can be approved for it.';
