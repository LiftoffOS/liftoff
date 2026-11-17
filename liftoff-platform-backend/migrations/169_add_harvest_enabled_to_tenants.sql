-- TENANT-OPT-001: per-tenant harvest killswitch for liftoff-harvest-service.
-- harvest_enabled = false  →  harvest service skips this tenant's connector events
-- harvest_enabled = true   →  connector events are classified and written to runtime memory
--
-- DEFAULT false: opt-in rollout. Enable per-tenant via:
--   UPDATE tenants SET harvest_enabled = true WHERE id = '<tenant-uuid>';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS harvest_enabled BOOLEAN NOT NULL DEFAULT false;
