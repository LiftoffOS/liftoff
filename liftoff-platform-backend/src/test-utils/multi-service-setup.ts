// Per-worker setup — runs inside each test worker before any tests.
// globalSetup populates the env vars; this file just ensures they're there.

beforeAll(() => {
  const required = [
    'CONTROL_PLANE_PG_URL',
    'CONNECTOR_PG_URL',
    'GOVERNANCE_PG_URL',
    'TENANT_PG_URL',
    'PUBSUB_EMULATOR_HOST',
  ];
  for (const v of required) {
    if (!process.env[v]) {
      throw new Error(
        `multi-service harness env var ${v} not set — was docker-compose.integration.yml started?`,
      );
    }
  }
});
