-- Seed the operator kill-switch for the external-content write gate so it is always
-- settable per tenant (setTenantOverride throws if the flag row is absent).
--
-- Negative polarity: enabled=false is the GLOBAL default and means the gate is ON.
-- A per-tenant override to true disables the gate for that one tenant (emergency
-- lever). A missing tenant override resolves to the global default (false → gate ON).
INSERT INTO feature_flags (key, name, description, enabled)
VALUES (
  'external_content_write_gate_disabled',
  'External-content write gate disabled',
  'Kill-switch (negative polarity): a per-tenant override to true disables the external_content_write HITL gate for that tenant. Global default false = gate ON.',
  false
)
ON CONFLICT (key) DO NOTHING;
