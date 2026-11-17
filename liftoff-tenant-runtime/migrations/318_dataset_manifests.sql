-- D1 (rev 8) — trajectory dataset manifests + the immutable per-manifest curation snapshot.
--
-- The manifest is RESERVED (status='assembling') before selection; completion fields are
-- NULLABLE while assembling and the shape CHECKs enforce ONLY on completion. The curation row
-- persists the frozen selection (first-writer-wins) so a crash-retry never re-embeds and emits
-- byte-identical artifacts. RLS + FORCE (TR GUC app.tenant_id); census in 318_dataset_manifests.test.ts.

CREATE TABLE dataset_manifests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  UNIQUE (id, tenant_id),   -- rev 26: composite parent key so dataset_manifest_curation can
                            -- FK (manifest_id, tenant_id) — prevents attaching tenant A's manifest
                            -- to tenant B's RLS identity (verified P1 cross-tenant exposure risk)
  agent_id UUID,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('sft','preference_pairs','reward_records')),
  vendor TEXT CHECK (vendor IN ('gemini')),   -- NULL for pairs/reward (vendor-neutral)
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  exporter_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  base_model TEXT,                             -- sft only
  train_gcs_path TEXT,  train_count INT,
  validation_gcs_path TEXT, validation_count INT,   -- NULL for pairs/reward (single artifact)
  gcs_path TEXT, row_count INT,                     --   uses gcs_path/row_count
  excluded JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'assembling' CHECK (status IN ('assembling','complete')),
  content_hash TEXT,                           -- set at completion
  train_content_hash TEXT, validation_content_hash TEXT,   -- rev 16 per-file hashes
  config_hash TEXT NOT NULL,                   -- rev 15: sha256({schema_version, base_model, curation params})
  label_watermark_at TIMESTAMPTZ NOT NULL,     -- reserved BEFORE selection (rev 16)
  trainable BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- rev 17: shape constraints enforce ONLY on completion
  CONSTRAINT complete_has_hash CHECK (status = 'assembling' OR content_hash IS NOT NULL),
  CONSTRAINT sft_shape CHECK (
    status = 'assembling' OR artifact_type != 'sft'
    OR (vendor IS NOT NULL AND base_model IS NOT NULL
        AND train_gcs_path IS NOT NULL AND validation_gcs_path IS NOT NULL
        AND train_content_hash IS NOT NULL AND validation_content_hash IS NOT NULL
        AND train_count IS NOT NULL AND train_count >= 0
        AND validation_count IS NOT NULL AND validation_count >= 0
        AND gcs_path IS NULL)),
  CONSTRAINT single_artifact_shape CHECK (
    status = 'assembling' OR artifact_type = 'sft'
    OR (vendor IS NULL AND train_gcs_path IS NULL AND validation_gcs_path IS NULL
        AND gcs_path IS NOT NULL AND row_count IS NOT NULL AND row_count >= 0)),
  CONSTRAINT trainable_only_complete CHECK (NOT trainable OR status = 'complete')
);
-- rev 12: the composite UNIQUE contained nullable vendor/agent_id (Postgres treats NULLs as
-- distinct, so vendor-neutral manifests would never conflict). Portable fix: one partial unique
-- EXPRESSION index. rev 15: config_hash is IN the key.
CREATE UNIQUE INDEX manifest_idempotency ON dataset_manifests
  (tenant_id, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid),
   artifact_type, COALESCE(vendor, '-'), window_start, window_end,
   exporter_version, config_hash);

ALTER TABLE dataset_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE dataset_manifests FORCE ROW LEVEL SECURITY;
CREATE POLICY dataset_manifests_tenant ON dataset_manifests
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Immutable curation snapshot (rev 24/25/26). The composite FK ties the child's tenant_id to the
-- PARENT manifest's, so a bad insert can't attach one tenant's manifest to another tenant's RLS
-- identity. Persists the ORDERED selected ids + EVERY exclusion reason so kept set, emission order,
-- and excluded counts are ALL reproducible; a crash-retry READS this row and never re-embeds.
CREATE TABLE dataset_manifest_curation (
  manifest_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  selected_invocation_ids UUID[] NOT NULL,   -- ORDERED, kept representatives
  exclusions JSONB NOT NULL,                 -- every reason: {rejected,corrected,flagged,dup,pii}
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (manifest_id, tenant_id)
    REFERENCES dataset_manifests (id, tenant_id) ON DELETE CASCADE
);
ALTER TABLE dataset_manifest_curation ENABLE ROW LEVEL SECURITY;
ALTER TABLE dataset_manifest_curation FORCE ROW LEVEL SECURITY;
CREATE POLICY dataset_manifest_curation_tenant ON dataset_manifest_curation
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
