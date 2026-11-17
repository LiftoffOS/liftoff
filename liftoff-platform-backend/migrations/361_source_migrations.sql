-- Liftoff Switch — source migration persistence.
--
-- A migration is one attempt to bring an OpenClaw or Hermes installation into
-- Liftoff. The module COORDINATES existing services (distill, create,
-- absorption, memory, skill, connector, trigger); it is deliberately not a
-- second agent-provisioning path, so nothing here duplicates an
-- internal_agents column.
--
-- The item table is the durable idempotency ledger. LLM distillation is not
-- deterministic, but the source-to-destination MAPPING must be: a retry reads
-- this table before performing any LLM or create work, so a crash between
-- distill and create never spends a second distill, and a crash between create
-- and mapping never produces a duplicate team member.
--
-- Subscription truth is NOT stored here. INV-PB-010: billing_controls plus the
-- OU buckets are the one money authority, and a migration must never become a
-- second one. The conversion admission check reads the existing entitlement
-- snapshot at the moment it runs.

CREATE TABLE source_migrations (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID NOT NULL REFERENCES tenants(id),

  -- Which incumbent this came from. DeerFlow, Omnigent and Agno are deferred;
  -- the CHECK is the enforcement, so an unsupported source cannot be persisted
  -- by a future caller that forgot.
  source                    TEXT NOT NULL CHECK (source IN ('openclaw', 'hermes')),
  source_version            TEXT,
  adapter_version           TEXT NOT NULL,

  -- Identifies the installation the bundle was taken from. Re-running the CLI
  -- against the same installation must RESUME, which is what this keys.
  installation_fingerprint  TEXT NOT NULL,

  -- importing        — created; bundle may not have arrived yet.
  -- setup_required   — material does not fit, or a selection is needed.
  -- payment_required — nothing billable has run; awaiting a paid subscription.
  -- conversion_queued/converting — post-payment LLM work in flight.
  -- conversion_ready — every selected item converted or failed with an
  --                    actionable error.
  -- ready_to_cutover — conversion plus required setup are complete.
  -- active           — the user confirmed cutover and the team was activated.
  -- failed           — terminal.
  state                     TEXT NOT NULL DEFAULT 'importing'
                              CHECK (state IN (
                                'importing', 'setup_required', 'payment_required',
                                'conversion_queued', 'converting', 'conversion_ready',
                                'ready_to_cutover', 'active', 'failed'
                              )),

  -- The normalized inventory as uploaded (already redacted on the user's
  -- machine). Stored so a resume re-reads exactly what the user reviewed
  -- rather than asking them to scan again.
  bundle                    JSONB,
  -- Per-item conversion results and unsupported items, for the review surface.
  unsupported_items         JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Connection requirements that have no placeholder UUID: local stdio MCP
  -- servers and unreachable endpoints. Deliberately NOT connector rows.
  hosting_requirements      JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Non-secret diagnostics for support. Never contains source content.
  diagnostics               JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Artifact names the user explicitly approved for the shared knowledge
  -- library. Invariant 9: agent-scoped context lands immediately, but
  -- workspace-scoped context is a curated help centre and never a dump target,
  -- so nothing reaches it without a name appearing in this list.
  library_approvals         JSONB NOT NULL DEFAULT '[]'::jsonb,

  last_error                TEXT,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  converted_at              TIMESTAMPTZ,
  completed_at              TIMESTAMPTZ
);

-- One live migration per installation per tenant. This is what makes
-- `switch --from <source>` resume instead of starting a parallel migration,
-- and it is a partial index so a completed migration does not block a later
-- re-import of the same installation.
CREATE UNIQUE INDEX idx_source_migrations_live
  ON source_migrations (tenant_id, source, installation_fingerprint)
  WHERE state NOT IN ('active', 'failed');

CREATE INDEX idx_source_migrations_tenant ON source_migrations (tenant_id, created_at DESC);
CREATE INDEX idx_source_migrations_state ON source_migrations (state, updated_at)
  WHERE state IN ('conversion_queued', 'converting');

ALTER TABLE source_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_migrations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON source_migrations
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);


-- One row per selected persistent source identity.
--
-- This is the idempotency ledger described above. The three-stage rule it
-- enforces:
--   destination_agent_id present        -> return it; never distill, never create.
--   distill_output present, no agent id -> create from the stored output; never redistill.
--   neither                             -> may distill, subject to attempt_count.
CREATE TABLE source_migration_items (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id            UUID NOT NULL REFERENCES source_migrations(id) ON DELETE CASCADE,
  tenant_id               UUID NOT NULL REFERENCES tenants(id),

  -- Stable reference within the source installation (e.g. 'agent:research').
  source_ref              TEXT NOT NULL,
  -- Hash of the BOUNDED input, computed after the distill-input normalization
  -- rules ran. A changed source snapshot therefore produces a different hash
  -- and a new item version rather than silently changing a converted member.
  normalized_input_hash   TEXT NOT NULL,

  -- The canonical distill input for this identity, and its attachments.
  distill_input           JSONB NOT NULL,

  state                   TEXT NOT NULL DEFAULT 'pending'
                            CHECK (state IN ('pending', 'distilling', 'creating', 'converted', 'failed')),
  attempt_count           INT NOT NULL DEFAULT 0,
  last_error              TEXT,

  -- The successful distill output, persisted BEFORE agent creation is
  -- attempted. This is what makes a crash between the two cost nothing.
  distill_output          JSONB,

  -- internal_agents.id. NEVER the Tenant Runtime's separate agents.id: the two
  -- spaces are disjoint and a wrong-space id matches zero rows with no error
  -- (ADR-039).
  destination_agent_id    UUID,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  converted_at            TIMESTAMPTZ
);

-- The idempotency key: migration plus stable source reference.
CREATE UNIQUE INDEX idx_source_migration_items_key
  ON source_migration_items (migration_id, source_ref);

CREATE INDEX idx_source_migration_items_tenant ON source_migration_items (tenant_id);
CREATE INDEX idx_source_migration_items_pending
  ON source_migration_items (migration_id, state)
  WHERE state IN ('pending', 'distilling', 'creating');

ALTER TABLE source_migration_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_migration_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON source_migration_items
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);


-- Imported routines, and the first-scheduled-run health record.
--
-- Cutover completion must not imply that imported recurring work has already
-- succeeded. Every imported routine starts 'awaiting' and is moved to
-- 'succeeded' or 'failed' by the FIRST terminal scheduled outcome reported by
-- the Tenant Runtime. This is asynchronous on purpose: a monthly routine must
-- not hold a migration open for a month.
CREATE TABLE source_migration_routines (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id          UUID NOT NULL REFERENCES source_migrations(id) ON DELETE CASCADE,
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  item_id               UUID REFERENCES source_migration_items(id) ON DELETE SET NULL,

  source_ref            TEXT NOT NULL,
  name                  TEXT NOT NULL,
  cron_expr             TEXT NOT NULL,
  prompt                TEXT NOT NULL DEFAULT '',
  -- Whether it was enabled in the SOURCE. Recorded for the review surface;
  -- imported routines are created disabled regardless and stay disabled until
  -- cutover, which is what keeps duplicate execution the user's explicit
  -- choice rather than an accident of import.
  enabled_in_source     BOOLEAN NOT NULL DEFAULT TRUE,
  -- Whether the user accepted this routine during review.
  accepted              BOOLEAN NOT NULL DEFAULT TRUE,
  enabled_at_cutover    BOOLEAN NOT NULL DEFAULT FALSE,

  -- internal_agents.id of the converted owner (see ADR-039 note above).
  destination_agent_id  UUID,

  -- The stable reference carried into the Tenant Runtime and echoed back on
  -- the terminal outcome, so a report can be matched without the control plane
  -- inventing an id translation.
  routine_ref           TEXT NOT NULL,

  first_run_status      TEXT NOT NULL DEFAULT 'awaiting'
                          CHECK (first_run_status IN ('awaiting', 'succeeded', 'failed')),
  first_run_at          TIMESTAMPTZ,
  -- Non-secret failure category only. Never a message from a customer's run.
  first_run_error_category TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_source_migration_routines_key
  ON source_migration_routines (migration_id, source_ref);
-- The lookup the first-run report uses. Unique so a duplicate delivery cannot
-- match two rows.
CREATE UNIQUE INDEX idx_source_migration_routines_ref
  ON source_migration_routines (tenant_id, routine_ref);
CREATE INDEX idx_source_migration_routines_awaiting
  ON source_migration_routines (tenant_id, first_run_status)
  WHERE first_run_status = 'awaiting';

ALTER TABLE source_migration_routines ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_migration_routines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON source_migration_routines
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);


-- Connection requirements that DO have (or will have) a real connector UUID.
--
-- A catalog connector or a reachable custom MCP server becomes a credential-less
-- placeholder in connector-service, and the imported agent binds to that exact
-- UUID. Reconnection heals the same UUID to 'active' and the binding becomes
-- usable without rewriting the agent.
--
-- Connector ids belong to connector-service's own database (ADR-049), so
-- connector_id is deliberately NOT a foreign key: a lookup there returns zero
-- rows rather than an error, and FK-ing it is the exact mistake migration 267
-- made.
CREATE TABLE source_migration_connections (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id            UUID NOT NULL REFERENCES source_migrations(id) ON DELETE CASCADE,
  tenant_id               UUID NOT NULL REFERENCES tenants(id),

  source_ref              TEXT NOT NULL,
  -- 'catalog'  — matches a Liftoff catalog connector; reconnect through its
  --              normal setup flow.
  -- 'mcp_http' — customer-owned remote MCP server; completed through the
  --              custom-MCP import-completion flow.
  kind                    TEXT NOT NULL CHECK (kind IN ('catalog', 'mcp_http')),
  connector_type          TEXT NOT NULL,
  display_name            TEXT,
  -- Non-secret endpoint configuration for an imported MCP server. Never holds
  -- an authentication secret and never a custom header VALUE.
  endpoint_url            TEXT,
  auth_scheme             TEXT,
  custom_header_names     JSONB NOT NULL DEFAULT '[]'::jsonb,
  external_account_label  TEXT,

  -- The canonical connector UUID once the placeholder exists.
  connector_id            UUID,
  -- Paired custom_mcp_servers.id for kind='mcp_http'.
  custom_mcp_server_id    UUID,

  status                  TEXT NOT NULL DEFAULT 'placeholder_pending'
                            CHECK (status IN ('placeholder_pending', 'needs_reconnect', 'active', 'dismissed')),

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Creation and completion are idempotent on migration id plus source ref.
CREATE UNIQUE INDEX idx_source_migration_connections_key
  ON source_migration_connections (migration_id, source_ref);
CREATE INDEX idx_source_migration_connections_tenant
  ON source_migration_connections (tenant_id);
CREATE INDEX idx_source_migration_connections_connector
  ON source_migration_connections (tenant_id, connector_id)
  WHERE connector_id IS NOT NULL;

ALTER TABLE source_migration_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_migration_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON source_migration_connections
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
