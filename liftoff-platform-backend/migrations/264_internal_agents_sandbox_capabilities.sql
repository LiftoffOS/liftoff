-- internal_agents.sandbox_capabilities — per-agent enable/disable of sandbox capability families.
-- Default = all four; flows through tenant.internal_agent.runtime_config_updated Pub/Sub event
-- into tenant-runtime's compiled_instructions cache.
ALTER TABLE internal_agents
  ADD COLUMN IF NOT EXISTS sandbox_capabilities text[] NOT NULL DEFAULT ARRAY['shell','file','browser','vscode'];

UPDATE internal_agents
  SET sandbox_capabilities = ARRAY['shell','file','browser','vscode']
  WHERE capability_tier = 'execution_enabled' AND sandbox_capabilities IS NULL;

UPDATE internal_agents
  SET sandbox_capabilities = ARRAY[]::text[]
  WHERE capability_tier = 'connector_only';
