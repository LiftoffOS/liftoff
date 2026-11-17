-- A census of what exists in each connected system, and the checkpoints that
-- let it be built incrementally.
--
-- An agent's entire knowledge of its systems today is the prompt's capability
-- block — which systems it can reach, and nothing about what is IN them. So
-- every task opens with exploratory calls just to find out what it is working
-- with, and every one of those calls costs vendor quota.
--
-- METADATA ONLY. Enumeration is paginated (listing 10,000 entities costs on
-- the order of 100 calls); hydration is per-entity (the same 10,000 entities
-- cost 10,000 calls). Two orders of magnitude apart out of one budget. The
-- census fits; a content crawl does not. `content_hash` and `hydration_state`
-- exist to record what happens to be captured elsewhere, not to invite a crawl.

CREATE TABLE connector_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id UUID NOT NULL,
  connector_type TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  title TEXT,
  -- Stable human-readable address, e.g. `slack/channels/engineering`. What an
  -- agent is shown and what a later mount design would materialise as a path.
  projected_path TEXT NOT NULL,
  parent_remote_id TEXT,
  remote_version TEXT,
  content_hash TEXT,
  hydration_state TEXT NOT NULL DEFAULT 'stub'
    CHECK (hydration_state IN ('stub','hydrated','unavailable')),
  freshness_tier TEXT NOT NULL DEFAULT 'cold'
    CHECK (freshness_tier IN ('hot','warm','cold','dormant')),
  next_check_at TIMESTAMPTZ,
  last_touched_at TIMESTAMPTZ,
  -- Soft delete. A row that disappears from the source is marked, never
  -- removed: "it used to be here" is the answer to a real question, and a hard
  -- delete would make a botched enumeration indistinguishable from an empty
  -- workspace.
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, connector_id, remote_id)
);

CREATE INDEX idx_connector_entities_type
  ON connector_entities (tenant_id, connector_id, entity_type);
CREATE INDEX idx_connector_entities_due
  ON connector_entities (tenant_id, next_check_at) WHERE NOT deleted;

-- Resumable enumeration checkpoints, one row per (tenant, connector, scope).
--
-- `cursor` advances ONLY after its batch is fully reconciled. A cursor written
-- before reconciliation would skip whatever the failed batch contained, and the
-- gap would be invisible — the census would simply report fewer things than
-- exist, which reads exactly like a small workspace.
CREATE TABLE connector_enumeration_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id UUID NOT NULL,
  connector_type TEXT NOT NULL,
  -- Which slice of the connector this job enumerates (an entity type, a
  -- workspace, a folder). One cursor per scope so a slow scope cannot hold up
  -- the others.
  scope TEXT NOT NULL,
  cursor TEXT,
  -- 'complete' means the batch series covered the whole scope, so an entity
  -- absent from it is genuinely gone. 'incremental' means it did not, and
  -- absence proves nothing. Only a complete pass may mark rows deleted.
  last_batch_kind TEXT CHECK (last_batch_kind IN ('complete','incremental')),
  last_completed_at TIMESTAMPTZ,
  -- When this job is next eligible to run. A vendor rate-limit response parks
  -- the job here (now + Retry-After + jitter) instead of sleeping a worker.
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, connector_id, scope)
);

CREATE INDEX idx_connector_enumeration_due
  ON connector_enumeration_state (next_run_at);

-- RLS, fail-loud.
--
-- `current_setting('app.tenant_id')` WITHOUT the `true` second argument: a
-- missing GUC raises rather than returning NULL. The silent variant compares
-- tenant_id to NULL, which is never true, so every query returns ZERO ROWS and
-- succeeds. For a table whose entire job is answering "what exists", a silent
-- empty result is the worst possible failure — indistinguishable from a real
-- answer. Migration 079 documents the convention.
ALTER TABLE connector_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_entities FORCE ROW LEVEL SECURITY;
CREATE POLICY connector_entities_tenant ON connector_entities
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

ALTER TABLE connector_enumeration_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_enumeration_state FORCE ROW LEVEL SECURITY;
CREATE POLICY connector_enumeration_state_tenant ON connector_enumeration_state
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
