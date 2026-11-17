-- Audit + current-value store for the auto-calibrated curation constant (the near-dup similarity
-- cutoff): one row per calibration run recording the estimator output, the applied value after the
-- guardrails, and the outcome (hold|promote|rollback). RLS + FORCE on the tenant GUC
-- (app.tenant_id); cross-tenant denial covered in 320_calibration_runs.test.ts.
CREATE TABLE calibration_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  constant_name TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  sample_count INT NOT NULL,
  estimator_output DOUBLE PRECISION,
  applied_value DOUBLE PRECISION,               -- after clamp + bounded step
  outcome TEXT NOT NULL CHECK (outcome IN ('hold','promote','rollback')),
  guardrail_delta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_calib_constant ON calibration_runs (tenant_id, constant_name, created_at DESC);
ALTER TABLE calibration_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE calibration_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY calibration_runs_tenant ON calibration_runs
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
