-- Migration 263: outbox trigger on model_configs.
--
-- Closes a drift hole: PB can hold the canonical routing_policy while
-- TR's cached_model_configs row still has an older seed shape, because
-- migrations that change model_configs as pure SQL UPDATEs (such as 187,
-- tier routing, and 188, embedding override) never fire
-- tenant.model_config.updated events. TR's cache sync rides on those events.
--
-- This trigger catches every model_configs INSERT / UPDATE / DELETE
-- (migrations, application code, manual psql ops) and inserts a
-- corresponding row into control_plane_outbox. The standard publisher
-- pipeline picks it up and the TR subscriber replaces the cached row.
--
-- The trigger function wraps the outbox INSERT in EXCEPTION WHEN OTHERS
-- so a transient outbox failure does NOT block the model_configs write
-- itself. Drift through an outbox-only failure is recoverable via the
-- periodic reconciler (B-2) and the manual resync endpoint.
--
-- Matches the ON CONFLICT shape of src/events/outbox.ts:
-- enqueueControlPlaneOutbox so the trigger doesn't fight in-process
-- writers.

BEGIN;

CREATE OR REPLACE FUNCTION model_configs_emit_outbox()
RETURNS TRIGGER AS $$
DECLARE
  v_tenant_id      UUID;
  v_entity_id      TEXT;
  v_event_type     TEXT;
  v_entity_version INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_tenant_id      := OLD.tenant_id;
    v_entity_id      := OLD.id::text;
    v_event_type     := 'tenant.model_config.deleted';
    v_entity_version := OLD.version;
  ELSE
    v_tenant_id      := NEW.tenant_id;
    v_entity_id      := NEW.id::text;
    v_event_type     := CASE
                          WHEN TG_OP = 'INSERT' THEN 'tenant.model_config.created'
                          ELSE 'tenant.model_config.updated'
                        END;
    v_entity_version := NEW.version;
  END IF;

  BEGIN
    INSERT INTO control_plane_outbox
      (tenant_id, entity_type, entity_id, event_type, entity_version, event_payload)
    VALUES
      (v_tenant_id, 'model_config', v_entity_id, v_event_type, v_entity_version, '{}'::jsonb)
    ON CONFLICT (entity_type, entity_id, event_type)
      WHERE status IN ('pending', 'in_progress')
      DO UPDATE SET
        event_id        = gen_random_uuid(),
        entity_version  = EXCLUDED.entity_version,
        tenant_id       = EXCLUDED.tenant_id,
        status          = 'pending',
        attempts        = 0,
        last_error      = NULL,
        next_attempt_at = NOW(),
        updated_at      = NOW();
  EXCEPTION
    WHEN OTHERS THEN
      -- Outbox failed; model_configs write still succeeds. The periodic
      -- reconciler will detect drift and refresh. Log to RAISE NOTICE so
      -- the failure surfaces in postgres logs.
      RAISE NOTICE 'model_configs_emit_outbox: outbox insert failed: %', SQLERRM;
  END;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_model_configs_emit_outbox ON model_configs;
CREATE TRIGGER trg_model_configs_emit_outbox
AFTER INSERT OR UPDATE OR DELETE ON model_configs
FOR EACH ROW EXECUTE FUNCTION model_configs_emit_outbox();

COMMENT ON TRIGGER trg_model_configs_emit_outbox ON model_configs IS
  'Emits tenant.model_config.{created,updated,deleted} events to control_plane_outbox on every row mutation, so TR cache sync covers migrations and manual SQL ops in addition to application code.';

COMMIT;
