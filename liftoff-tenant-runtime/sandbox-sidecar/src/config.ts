// Sandbox sidecar boot-time configuration.
// All env vars are required at boot (entrypoint.sh also validates SANDBOX_JWT_SECRET).

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(`Required env var ${name} is not set`);
  }
  return value;
}

export const config = {
  sandboxId: requireEnv('SANDBOX_ID'),
  tenantId: requireEnv('TENANT_ID'),
  agentId: requireEnv('AGENT_ID'),
  instructionVersion: parseInt(requireEnv('INSTRUCTION_VERSION'), 10),
  runtimeBaseUrl: requireEnv('RUNTIME_BASE_URL'),
  jwtSecret: requireEnv('SANDBOX_JWT_SECRET'),
  sandboxPublicUrl: process.env.SANDBOX_PUBLIC_URL ?? '',
  workspaceDir: process.env.WORKSPACE_DIR ?? '/workspace',
  port: parseInt(process.env.PORT ?? '8090', 10),
  authPort: parseInt(process.env.AUTH_PORT ?? '8081', 10),
  maxOutputBytes: parseInt(process.env.MAX_OUTPUT_BYTES ?? '100000', 10),
  browserTabQueueMax: parseInt(process.env.BROWSER_TAB_QUEUE_MAX ?? '16', 10),
} as const;

export type SandboxConfig = typeof config;
