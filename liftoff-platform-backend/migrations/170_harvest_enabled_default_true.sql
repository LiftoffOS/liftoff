-- Flip harvest to on-by-default. The classifier (confidence >= 0.7), PII redaction,
-- and change-detection controls are in place. Opt-out remains possible per-tenant.
--
-- harvest_enabled = true  →  connector events classified and written to runtime memory
-- harvest_enabled = false →  harvest service skips this tenant (operator opt-out only)

-- Change column default so all new tenants get harvest enabled automatically
ALTER TABLE tenants ALTER COLUMN harvest_enabled SET DEFAULT true;

-- Backfill all existing tenants
UPDATE tenants SET harvest_enabled = true WHERE harvest_enabled = false;
