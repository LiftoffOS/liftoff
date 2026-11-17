// Jest globalSetup for integration tests.
//
// Responsibilities:
//   1. Point the service env at the local docker-compose Postgres.
//   2. Wait for Postgres readiness on 127.0.0.1:55432.
//   3. Verify the schema the integration tests exercise has been applied
//      (docker-compose mounts ./migrations as init SQL, so every *.sql runs
//      in lexical order on first container start — see REQUIRED_TABLES).
//   4. Provide a session-variable scaffold so tests can set `app.tenant_id`
//      for RLS assertions.
//
// Prerequisite (NOT enforced silently — if Postgres is not up, setup
// fails loudly with a clear hint): run
//
//   docker-compose -f docker-compose.integration.yml up -d
//
// Teardown (see integration-teardown.ts) closes the pool so jest exits
// cleanly; containers remain running so subsequent test invocations
// are fast.

import { Client } from 'pg';

const HOST = '127.0.0.1';
const PORT = 55432;
const DATABASE = 'connector_service';
const USER = 'connector_app';
const PASSWORD = process.env.DB_PASSWORD ?? 'connector_app_test';

const REQUIRED_TABLES = [
  'connectors',
  'connector_credentials',
  'connector_oauth_states',
  'connector_sync_stats',
  'oauth_dynamic_registrations',
  // migration 018 — exercised by response-capture.integration.test.ts. If a pre-018 volume is
  // reused this is the first table to go missing, and the hint below tells the user to re-init.
  'connector_response_samples',
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPostgres(): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    const client = new Client({
      host: HOST,
      port: PORT,
      database: DATABASE,
      user: USER,
      password: PASSWORD,
    });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (err) {
      lastErr = err;
      try {
        await client.end();
      } catch {
        /* ignore close errors */
      }
      await sleep(500);
    }
  }
  throw new Error(
    `integration postgres not ready on ${HOST}:${PORT} after 30s — did you run \`docker-compose -f docker-compose.integration.yml up -d\`? last error: ${
      (lastErr as Error)?.message ?? 'unknown'
    }`,
  );
}

async function verifyMigrations(): Promise<void> {
  const client = new Client({
    host: HOST,
    port: PORT,
    database: DATABASE,
    user: USER,
    password: PASSWORD,
  });
  await client.connect();
  try {
    const res = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [REQUIRED_TABLES],
    );
    const found = new Set(res.rows.map((r) => r.table_name));
    const missing = REQUIRED_TABLES.filter((t) => !found.has(t));
    if (missing.length > 0) {
      throw new Error(
        `integration postgres missing tables: ${missing.join(', ')} — ` +
          `did init SQL load? try \`docker-compose -f docker-compose.integration.yml down -v && up -d\``,
      );
    }
  } finally {
    await client.end();
  }
}

async function verifyRlsScaffold(): Promise<void> {
  // Sanity check that `app.tenant_id` behaves as a session setting (the
  // RLS variable used by every tenant-scoped policy in migrations 002
  // and 003). current_setting(..., true) returns '' when unset — that's
  // the 'missing_ok=true' form our pool uses.
  const client = new Client({
    host: HOST,
    port: PORT,
    database: DATABASE,
    user: USER,
    password: PASSWORD,
  });
  await client.connect();
  try {
    await client.query(`SELECT current_setting('app.tenant_id', true)`);
    await client.query(`SET LOCAL app.tenant_id = 'integration-probe'`);
  } finally {
    await client.end();
  }
}

export default async function globalSetup(): Promise<void> {
  // Ensure the service's pool factory resolves against the harness DB.
  process.env.DB_HOST = HOST;
  process.env.DB_PORT = String(PORT);
  process.env.DB_USER = USER;
  process.env.DB_PASSWORD = PASSWORD;
  process.env.DB_NAME = DATABASE;
  process.env.DB_ADMIN_USER = USER;
  process.env.DB_ADMIN_PASSWORD = PASSWORD;
  delete process.env.DB_INSTANCE_CONNECTION_NAME;
  process.env.CONNECTOR_SERVICE_TOKEN = 'integration-test-token';

  await waitForPostgres();
  await verifyMigrations();
  await verifyRlsScaffold();
}
