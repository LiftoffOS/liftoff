-- Migration 478: the editable profile of a coding-tool connection
--
-- A coding-tool connection on the teams page is one of two rows: a Switch-flow
-- credential, which the developer-proxy service owns in its own database, or
-- an mcp_tokens anchor (a static collab token or an OAuth grant). Neither has
-- a name the person chose or a description at all: the credential's label is
-- fixed at creation, the anchor's name is the client's registered name kept
-- for audit, and the description the row shows is derived on every read.
-- PUT /api/claude-code-proxy/keys/:id accepted a name and a description and
-- wrote nothing.
--
-- This table is where both now go, keyed by the connection id whichever
-- family it belongs to. The workforce assembly reads the profile over the
-- derived values, so a NULL column means "as derived". No FK on
-- connection_id: half the ids live in another database (the same rule
-- ADR-049 records for connector ids), and a profile whose connection is
-- gone is simply never joined again.
CREATE TABLE coding_tool_connection_profiles (
  connection_id UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 255),
  description   TEXT CHECK (description IS NULL OR char_length(description) <= 1000),
  updated_by    UUID NOT NULL REFERENCES accounts(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: ENABLE + FORCE + tenant policy (INV-PB-001), spelled out because the
-- DO-loops that blanket-enabled RLS (migrations 095/287/289) ran long ago and
-- never see a table created after them.
ALTER TABLE coding_tool_connection_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE coding_tool_connection_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON coding_tool_connection_profiles
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- The workforce read is one lookup per tenant.
CREATE INDEX idx_ctcp_tenant ON coding_tool_connection_profiles (tenant_id);

-- Pure DDL: nothing here reads or writes a row, so no NO FORCE / FORCE ROW
-- LEVEL SECURITY escape is needed.
