-- automatic self-calibration audit ledger.
--
-- One immutable row per (tenant, constant, weekly window) the calibration loop evaluates.
-- The row records the estimator output, the value actually applied after clamp + bounded
-- step, the outcome (hold|promote|rollback), and the guardrail deltas. The CURRENT calibrated
-- value of a constant is the most recent row for it with outcome='promote' (or, if none, the
-- constant's conservative compiled-in default — the safe cold-start no-op). There is no
-- approval gate: this table IS the after-the-fact review record.
--
-- tenant_id is TEXT to match action_trust_decisions (migration 021) and the GOV RLS GUC
-- (app.current_tenant_id, a text comparison — no ::uuid cast).

CREATE TABLE IF NOT EXISTS calibration_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  constant_name TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  sample_count INT NOT NULL,
  estimator_output DOUBLE PRECISION,            -- raw estimator value before clamp/step (null when held on thin data)
  applied_value DOUBLE PRECISION,               -- value in force after this run (after clamp + bounded step)
  outcome TEXT NOT NULL CHECK (outcome IN ('hold','promote','rollback')),
  guardrail_delta JSONB,                        -- { incumbent, candidate } guardrail metric values
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_calib_constant ON calibration_runs (tenant_id, constant_name, created_at DESC);

-- GOV RLS convention (migration 001: variable is app.current_tenant_id). FORCE so the table
-- owner can't bypass the policy; WITH CHECK so an insert can't write another tenant's row
-- even under a mis-set GUC. Census in the GOV migration-verification suite.
ALTER TABLE calibration_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE calibration_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY calibration_runs_tenant_isolation ON calibration_runs
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
