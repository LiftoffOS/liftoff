-- Tuned-model registry + promotion ledger (PB).
--
-- Placement note: tenant_tuned_models is written by PB's model-registry endpoints
-- (POST/PATCH .../tenant-tuned), read by PB promotion for ModelConfig.provider, and is the FK
-- target of tuning_promotions — whose referenced rows are both PB-owned. A PB→TR cross-database
-- FK is impossible, so tenant_tuned_models MUST live in PB; the FK is dispositive.
--
-- model_resource is IMMUTABLE (write-once at register): a changed winner is a NEW disabled row,
-- never a mutation, so the gate (which pins a row BY ID) evaluates and activates the SAME
-- resource with no post-promotion serving drift. Enforced by a BEFORE UPDATE trigger AND the
-- PATCH endpoint's field allow-list. RLS + FORCE (PB GUC app.current_tenant_id); census: add both
-- tables to 200_verification.integration.test.ts.

CREATE TABLE tenant_tuned_models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  provider TEXT NOT NULL,                                  -- a createAdapter provider id
  model_resource TEXT NOT NULL,                            -- IMMUTABLE (trigger-enforced)
  dataset_manifest_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'disabled'
    CHECK (status IN ('disabled','approved','deprecated')),
  status_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dataset_manifest_id, model_resource), -- register idempotency
  UNIQUE (id, tenant_id)                                   -- composite FK target for promotions
);
CREATE INDEX idx_ttm_agent ON tenant_tuned_models (tenant_id, agent_id, status);

-- IMMUTABLE model_resource: raise on any attempt to change it after registration.
CREATE OR REPLACE FUNCTION tenant_tuned_models_immutable_resource() RETURNS trigger AS $$
BEGIN
  IF NEW.model_resource IS DISTINCT FROM OLD.model_resource THEN
    RAISE EXCEPTION 'tenant_tuned_models.model_resource is immutable (row %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_ttm_immutable_resource
  BEFORE UPDATE ON tenant_tuned_models
  FOR EACH ROW EXECUTE FUNCTION tenant_tuned_models_immutable_resource();

ALTER TABLE tenant_tuned_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_tuned_models FORCE ROW LEVEL SECURITY;
CREATE POLICY ttm_tenant ON tenant_tuned_models
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Immutable promotion identity: rollback CASes against activated_config_hash; promote/rollback
-- are idempotent on (tenant_id, idempotency_key) with a stored request_hash.
CREATE TABLE tuning_promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  tenant_tuned_model_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  prior_config JSONB NOT NULL,
  prior_config_hash TEXT NOT NULL,
  activated_config JSONB NOT NULL,
  activated_config_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'promoted'
    CHECK (status IN ('promoted','rolled_back')),
  idempotency_key TEXT NOT NULL,                           -- the PROMOTE request's key
  request_hash TEXT NOT NULL,                              -- the PROMOTE request's canonical hash
  -- The ROLLBACK request's idempotency (set when the row is rolled back), so a rollback replay is
  -- request_hash-idempotent independently of the promote key.
  rollback_idempotency_key TEXT,
  rollback_request_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),                     -- promote idempotency
  FOREIGN KEY (tenant_tuned_model_id, tenant_id)
    REFERENCES tenant_tuned_models (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX idx_tp_model ON tuning_promotions (tenant_id, tenant_tuned_model_id, created_at DESC);
-- rollback idempotency lookup (partial: only rolled-back rows carry the key).
CREATE UNIQUE INDEX idx_tp_rollback_idem ON tuning_promotions (tenant_id, rollback_idempotency_key)
  WHERE rollback_idempotency_key IS NOT NULL;

ALTER TABLE tuning_promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tuning_promotions FORCE ROW LEVEL SECURITY;
CREATE POLICY tp_tenant ON tuning_promotions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
