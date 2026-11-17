-- Migration 431: capability-discovery persistence — blueprints + usage evidence.
--
-- The discovery service searches LIVE sources per query and mirrors no
-- catalog. What it does keep is OUR OWN artifacts about the outside world:
--
--   capability_blueprints — authored deep knowledge about one adopted
--   external automation (the procedure it implements, whether we can
--   replicate it through our stack, a pointer to a probe run's golden
--   output). Keyed by the source's stable ref, refreshed by a TARGETED
--   verifier that re-checks only referenced refs — never a catalog walk.
--
--   capability_usage_evidence — one row per real execution of a discovered
--   building block, whoever funded it. Evidence is what turns ranking from a
--   hypothesis into a loop: a candidate that failed for one workspace is
--   demoted for every workspace's next query.
--
-- Both tables are PLATFORM-scoped: no tenant_id boundary, no RLS. tenant_id
-- on an evidence row is attribution for diagnosis; the value of evidence is
-- exactly that it crosses workspaces.

CREATE TABLE capability_blueprints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,                -- 'apify_store' | 'connector_registry' | 'native_tool'
  source_ref TEXT NOT NULL,            -- stable ref within the source
  procedure_md TEXT NOT NULL,          -- OUR authored, schema-constrained analyzer output
  evidence_level TEXT NOT NULL CHECK (evidence_level IN ('metadata', 'source', 'probe')),
  golden_output_ref TEXT,              -- storage pointer to a probe run's output, nullable
  replicable BOOLEAN NOT NULL,
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dead BOOLEAN NOT NULL DEFAULT false, -- source_ref vanished upstream
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, source_ref)
);

CREATE TABLE capability_usage_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  tenant_id UUID,                      -- attribution only; the table is platform-scoped
  success BOOLEAN NOT NULL,
  latency_ms INTEGER,
  cost_usd NUMERIC(12,6),
  output_note TEXT,                    -- one-line shape note, never a payload
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_capability_usage_evidence_ref
  ON capability_usage_evidence (source, source_ref, created_at DESC);

-- capability_distill_consumption — which agent's distillation consumed which
-- external ref in its PRIOR ART section. This is what makes the upgrade loop
-- targetable: when a blueprint's evidence deepens (a probe run lands), the
-- agents whose instructions were authored against the shallower knowledge are
-- exactly the rows here, and only they get a platform redistill. Written on
-- redistills (the input carries the agent id there); an agent's first
-- distillation joins the record on its first redistill.
-- Platform-scoped like its siblings: the upgrade fan-out reads across
-- tenants, then redistills within each tenant's own scope.
CREATE TABLE capability_distill_consumption (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_id, source, source_ref)
);

CREATE INDEX idx_capability_distill_consumption_ref
  ON capability_distill_consumption (source, source_ref);
