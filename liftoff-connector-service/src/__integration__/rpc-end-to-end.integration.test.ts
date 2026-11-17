// End-to-end integration test against a real Postgres.
//
// Brings up the real Express app (via buildApp) on an ephemeral port,
// points a Connect-RPC client at it, and exercises the full stack:
//
//   HTTP request
//     → verifyServiceAuth middleware
//     → expressConnectMiddleware
//     → ConnectorService handler
//     → credentialService (DB + stubbed Secret Manager)
//     → response
//
// Three assertions:
//   1. GetCredentials returns the seeded api-key credential with the
//      correct flow kind.
//   2. Warm warms by connector TYPE — verifies the DB query is scoped
//      correctly and the type-level aggregation works.
//   3. RLS isolation — tenant A's rows are invisible when session is
//      scoped to tenant B.
//
// Secret Manager is STUBBED via __setSecretManagerClient so this test
// never touches GCP. The DB is real (the docker-compose-managed Postgres
// on localhost:55432).
//
// Prereq: `docker-compose -f docker-compose.integration.yml up -d`
// Runner: `npm run test:integration`

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { ConnectorService } from '@liftoffos/proto-gen';
import { AuthFlowKind } from '@liftoffos/proto-gen/liftoff/connector/v1/types_pb.js';
import { buildApp } from '../server.js';
import { logger } from '../infra/logging.js';
import { withTenantScope, getPool, closeAllPools } from '../db/pool.js';
import { __setSecretManagerClient } from '../secrets/client.js';

const TENANT_A = 'tenant-int-a';
const TENANT_B = 'tenant-int-b';

/** Fake SecretManagerServiceClient — returns pre-seeded credential JSON
 *  without ever reaching GCP. Matches the subset of the surface that
 *  src/secrets/client.ts uses (accessSecretVersion). */
function makeFakeSecretManager(
  secretsByName: Map<string, Record<string, unknown>>,
) {
  return {
    accessSecretVersion: async (req: { name: string }) => {
      // req.name: projects/<project>/secrets/<secretName>/versions/<v>
      const match = /secrets\/([^/]+)\/versions/.exec(req.name);
      const secretName = match?.[1] ?? '';
      const data = secretsByName.get(secretName);
      if (!data) {
        const err = new Error(`secret not found: ${secretName}`) as Error & {
          code: number;
        };
        err.code = 5;
        throw err;
      }
      return [{ payload: { data: Buffer.from(JSON.stringify(data)) } }];
    },
    addSecretVersion: async () => [{ name: 'latest' }],
    createSecret: async () => [{}],
    deleteSecret: async () => [{}],
  } as unknown as Parameters<typeof __setSecretManagerClient>[0];
}

async function startServer(): Promise<{ server: http.Server; baseUrl: string }> {
  const app = buildApp({ port: 0, log: logger });
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
    server.on('error', reject);
  });
}

function makeConnectClient(baseUrl: string) {
  const transport = createConnectTransport({
    baseUrl,
    httpVersion: '1.1',
    interceptors: [
      (next) => async (req) => {
        req.header.set(
          'X-Service-Auth',
          process.env.CONNECTOR_SERVICE_TOKEN ?? 'integration-test-token',
        );
        return next(req);
      },
    ],
  });
  return createClient(ConnectorService, transport);
}

function tenantCtx(tenantId: string) {
  return { tenantId, tier: '', projectId: '' };
}

async function seedConnector(
  tenantId: string,
  type: string,
  name: string,
): Promise<string> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query<{ id: string }>(
      `INSERT INTO connectors (tenant_id, type, name, status, config)
         VALUES ($1, $2, $3, 'active', '{}'::jsonb)
         RETURNING id`,
      [tenantId, type, name],
    );
    return res.rows[0].id;
  });
}

async function seedCredentialRow(
  tenantId: string,
  connectorId: string,
  flowKind: 'api_key' | 'static_oauth',
): Promise<void> {
  await withTenantScope(tenantId, async (client) => {
    await client.query(
      `INSERT INTO connector_credentials
         (connector_id, tenant_id, flow_kind, secret_name, scopes, expires_at_epoch_sec)
         VALUES ($1, $2, $3::auth_flow_kind, $4, $5, $6)`,
      [
        connectorId,
        tenantId,
        flowKind,
        `connector-${tenantId}-${connectorId}`,
        [],
        null,
      ],
    );
  });
}

async function resetDb(): Promise<void> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    // Bypass RLS for cleanup — these DELETEs need to span tenants.
    // Using the same role, so we clear with tenant-scoped loops.
    for (const t of [TENANT_A, TENANT_B]) {
      // `SET LOCAL app.tenant_id = $1` is invalid — SET does not accept bind params, and SET LOCAL
      // outside a transaction is a no-op. Use set_config at session scope (third arg false) so the
      // RLS variable persists across the subsequent DELETEs on this same client.
      await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [t]);
      await client.query(`DELETE FROM connector_credentials WHERE tenant_id = $1`, [t]);
      await client.query(`DELETE FROM connectors WHERE tenant_id = $1`, [t]);
    }
  } finally {
    client.release();
  }
}

describe('ConnectorService end-to-end (real Postgres + stubbed Secret Manager)', () => {
  let server: http.Server;
  let client: ReturnType<typeof makeConnectClient>;
  const secrets = new Map<string, Record<string, unknown>>();

  beforeAll(async () => {
    __setSecretManagerClient(makeFakeSecretManager(secrets));
    const started = await startServer();
    server = started.server;
    client = makeConnectClient(started.baseUrl);
  });

  afterAll(async () => {
    __setSecretManagerClient(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeAllPools();
  });

  beforeEach(async () => {
    secrets.clear();
    await resetDb();
  });

  it('GetCredentials returns an API_KEY credential for the seeded connector', async () => {
    const connectorId = await seedConnector(TENANT_A, 'stripe', 'primary');
    await seedCredentialRow(TENANT_A, connectorId, 'api_key');
    secrets.set(`connector-${TENANT_A}-${connectorId}`, {
      apiKey: 'sk_live_integration_fake',
    });

    const res = await client.getCredentials({
      tenantContext: tenantCtx(TENANT_A),
      connectorId,
    });

    expect(res.flowKind).toBe(AuthFlowKind.API_KEY);
    expect(res.apiKey?.apiKey).toBe('sk_live_integration_fake');
    expect(res.oauth).toBeUndefined();
  });

  it('Warm resolves connector types → ids and reports them as warmed', async () => {
    const slackId = await seedConnector(TENANT_A, 'slack', 'main');
    await seedCredentialRow(TENANT_A, slackId, 'static_oauth');
    secrets.set(`connector-${TENANT_A}-${slackId}`, {
      accessToken: 'xoxb-fake',
      refreshToken: 'xoxr-fake',
    });

    const res = await client.warm({
      tenantContext: tenantCtx(TENANT_A),
      connectorTypes: ['slack', 'github'], // github has 0 rows → failure
    });

    expect(res.warmedConnectorTypes).toEqual(['slack']);
    const githubFailure = res.failures.find((f) => f.connectorType === 'github');
    expect(githubFailure).toBeDefined();
  });

  it('RLS isolates tenants — tenant B cannot see tenant A rows', async () => {
    // Seed tenant A.
    const connAId = await seedConnector(TENANT_A, 'notion', 'a-notion');
    await seedCredentialRow(TENANT_A, connAId, 'api_key');
    secrets.set(`connector-${TENANT_A}-${connAId}`, { apiKey: 'a-key' });

    // Under tenant B's scope, the tenant A row must be invisible.
    const rowsVisibleToB = await withTenantScope(TENANT_B, async (c) => {
      const r = await c.query(`SELECT id FROM connectors WHERE id = $1`, [connAId]);
      return r.rows;
    });
    expect(rowsVisibleToB).toHaveLength(0);

    // And the RPC call from tenant B should also not find it.
    await expect(
      client.getCredentials({
        tenantContext: tenantCtx(TENANT_B),
        connectorId: connAId,
      }),
    ).rejects.toThrow(/No credentials found/);

    // Under tenant A, the row IS visible.
    const rowsVisibleToA = await withTenantScope(TENANT_A, async (c) => {
      const r = await c.query(`SELECT id FROM connectors WHERE id = $1`, [connAId]);
      return r.rows;
    });
    expect(rowsVisibleToA).toHaveLength(1);
  });
});
