// Multi-service integration global setup (Phase 0c).
//
// Starts the 4-Postgres + Pub/Sub emulator stack defined in
// docker-compose.integration.yml and waits for every service to pass its
// healthcheck. On CI, this runs once per test suite; tests reuse the
// running infrastructure.

import { execSync } from 'child_process';

const COMPOSE_FILE = 'docker-compose.integration.yml';
const SERVICES = [
  'control-plane-pg',
  'connector-pg',
  'governance-pg',
  'tenant-pg',
  'pubsub-emulator',
];

const MAX_WAIT_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;

function sh(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function waitForHealthy(service: string, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    try {
      const state = sh(
        `docker-compose -f ${COMPOSE_FILE} ps --format json ${service}`,
      );
      // `docker-compose ps --format json` emits one JSON object per line
      // (jsonl) in recent versions. Parse defensively.
      const line = state.trim().split('\n')[0];
      if (line) {
        const row = JSON.parse(line);
        if (row.Health === 'healthy' || row.State === 'running') {
          return;
        }
      }
    } catch {
      // Keep polling
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Service ${service} did not become healthy in time`);
}

export default async function globalSetup(): Promise<void> {
  console.log('[multi-service] Starting docker-compose stack...');

  try {
    sh(`docker-compose -f ${COMPOSE_FILE} up -d`);
  } catch (err) {
    console.error('[multi-service] docker-compose up failed');
    console.error((err as Error).message);
    throw err;
  }

  const deadline = Date.now() + MAX_WAIT_MS;
  for (const svc of SERVICES) {
    console.log(`[multi-service] Waiting for ${svc}...`);
    await waitForHealthy(svc, deadline);
  }

  // Expose a marker so setup file in each test worker can read config.
  process.env.MULTI_SERVICE_ACTIVE = '1';
  process.env.CONTROL_PLANE_PG_URL =
    'postgresql://liftoff_test:test_password@127.0.0.1:5433/liftoff_control_test';
  process.env.CONNECTOR_PG_URL =
    'postgresql://connector_test:test_password@127.0.0.1:5434/connector_test';
  process.env.GOVERNANCE_PG_URL =
    'postgresql://governance_test:test_password@127.0.0.1:5435/governance_test';
  process.env.TENANT_PG_URL =
    'postgresql://tenant_test:test_password@127.0.0.1:5436/tenant_runtime_test';
  process.env.PUBSUB_EMULATOR_HOST = '127.0.0.1:8085';
  process.env.PUBSUB_PROJECT_ID = 'test';

  console.log('[multi-service] Stack is up.');
}
