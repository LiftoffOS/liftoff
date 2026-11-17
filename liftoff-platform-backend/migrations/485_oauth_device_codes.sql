-- Migration 485: OAuth 2.0 device authorization grant (RFC 8628)
--
-- The front door (migration 291) assumes the OAuth client shares a browser
-- and localhost with the person: every native client registers a loopback
-- redirect and the consent page ends by navigating to it. A coding tool that
-- runs somewhere else (a container, a remote host, a tool driven from a
-- phone) has no such page to land on. The device flow is the standard answer:
-- the tool asks for a pair of codes, shows the person the short one and
-- <site>/activate, and polls the token endpoint until the person has
-- approved on any device they like.
--
-- One row per device authorization. Platform-global and non-RLS like
-- oauth_authorization_requests: a row is born before any tenant is known and
-- the grant it ends up pointing at carries the tenant. The device code the
-- tool holds is stored hashed, like every other secret in this family; the
-- user code the person types is not a secret (it is on a screen) and is
-- looked up by value.
--
-- Status is the polling state machine: pending until the person decides,
-- approved (grant_id set) or denied, consumed once tokens were issued. Rows
-- are kept an hour past expiry so a client still polling receives
-- access_denied or expired_token rather than a vanished row.
CREATE TABLE oauth_device_codes (
  device_code_hash TEXT PRIMARY KEY,
  user_code        TEXT NOT NULL,
  client_id        TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  client_name      TEXT NOT NULL,
  scope            TEXT NOT NULL DEFAULT 'mcp',
  resource         TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  grant_id         UUID,
  interval_seconds INTEGER NOT NULL DEFAULT 5,
  last_polled_at   TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The person's lookup, and the guarantee that a live code is unambiguous.
CREATE UNIQUE INDEX idx_oauth_device_codes_user_code_pending
  ON oauth_device_codes (user_code) WHERE status = 'pending';

-- Cleanup scans by expiry.
CREATE INDEX idx_oauth_device_codes_expiry ON oauth_device_codes (expires_at);

-- Pure DDL on a non-RLS table: nothing here reads or writes a row.
