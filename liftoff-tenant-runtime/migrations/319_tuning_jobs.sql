-- D3 — durable tuning-job state (a script-only flow loses the provider job id if the process
-- dies after createJob). The atomic claim (pending→creating) uses locked_at + lock_generation;
-- provider_attempts records EVERY create attempt for cleanup; RECONCILE-BEFORE-CREATE adopts an
-- existing provider job by label. FK (manifest_id, tenant_id) → dataset_manifests keeps the job's
-- manifest same-tenant. RLS + FORCE (TR GUC app.tenant_id); census in 319_tuning_jobs.test.ts.

CREATE TABLE tuning_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  manifest_id UUID NOT NULL,
  provider TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  provider_job_id TEXT,
  provider_attempts JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','creating','created','running','succeeded','failed')),
  tuned_model_id TEXT,
  error TEXT,
  locked_at TIMESTAMPTZ,
  lock_generation INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (manifest_id, provider, config_hash),
  FOREIGN KEY (manifest_id, tenant_id)
    REFERENCES dataset_manifests (id, tenant_id) ON DELETE CASCADE   -- same-tenant parent
);

ALTER TABLE tuning_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tuning_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tuning_jobs_tenant ON tuning_jobs
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
